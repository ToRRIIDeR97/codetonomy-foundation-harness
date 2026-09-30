import type { HarnessEventType, RunResult, VerificationResult } from "@agent-harness/contracts";
import { normalizeWriteClaim, writeClaimsOverlap, type WriteClaim } from "@agent-harness/tools";

export { normalizeWriteClaim, writeClaimsOverlap, type WriteClaim } from "@agent-harness/tools";

export const MAXIMUM_DELEGATION_DEPTH = 1;
export const MAXIMUM_CHILDREN_PER_RUN = 3;
export const MAXIMUM_PARALLEL_WRITERS = 2;

export interface OrchestrationNode {
	id: string;
	objective: string;
	presetId: string;
	permissionProfileId: "workspace-read" | "workspace-write";
	writePaths?: string[];
	dependencies?: string[];
}

export interface ChildExecutionContext {
	delegationDepth: 1;
	writeClaim: WriteClaim;
	verifiedDependencies: ReadonlyMap<string, RunResult>;
	signal?: AbortSignal;
}

export interface OrchestrationNodeResult {
	id: string;
	status: "completed" | "failed" | "skipped";
	run?: RunResult;
	error?: string;
}

export interface OrchestrationResult {
	output: string;
	verification: VerificationResult;
	children: OrchestrationNodeResult[];
}

export interface OrchestrationOptions {
	workspaceRoot: string;
	nodes: OrchestrationNode[];
	parentPermissionProfileId: "workspace-read" | "workspace-write";
	delegationDepth?: number;
	maximumParallelWriters?: number;
	signal?: AbortSignal;
	execute(node: OrchestrationNode, context: ChildExecutionContext): Promise<RunResult>;
	synthesize(verifiedChildren: ReadonlyMap<string, RunResult>, signal?: AbortSignal): Promise<string>;
	verifyFinal(output: string, verifiedChildren: ReadonlyMap<string, RunResult>): Promise<VerificationResult>;
	onEvent?(type: Extract<HarnessEventType, `subagent.${string}`>, data: Record<string, unknown>): void | Promise<void>;
}

interface ValidatedPlan {
	byId: Map<string, OrchestrationNode>;
	claims: Map<string, WriteClaim>;
	reachable: Map<string, Set<string>>;
}

async function validatePlan(options: OrchestrationOptions): Promise<ValidatedPlan> {
	if ((options.delegationDepth ?? 0) >= MAXIMUM_DELEGATION_DEPTH) throw new Error("Recursive delegation is disabled");
	if (!options.nodes.length || options.nodes.length > MAXIMUM_CHILDREN_PER_RUN) throw new Error(`Orchestration requires 1-${MAXIMUM_CHILDREN_PER_RUN} children`);
	if (options.maximumParallelWriters !== undefined && (!Number.isInteger(options.maximumParallelWriters) || options.maximumParallelWriters < 1 || options.maximumParallelWriters > MAXIMUM_PARALLEL_WRITERS)) {
		throw new Error(`maximumParallelWriters must be 1-${MAXIMUM_PARALLEL_WRITERS}`);
	}
	const byId = new Map<string, OrchestrationNode>();
	for (const node of options.nodes) {
		if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(node.id)) throw new Error(`Invalid child id: ${node.id}`);
		if (byId.has(node.id)) throw new Error(`Duplicate child id: ${node.id}`);
		if (!node.objective.trim()) throw new Error(`Child ${node.id} requires an objective`);
		if (!node.presetId.trim()) throw new Error(`Child ${node.id} requires a preset`);
		if (options.parentPermissionProfileId === "workspace-read" && node.permissionProfileId === "workspace-write") throw new Error(`Child ${node.id} cannot expand parent permissions`);
		byId.set(node.id, node);
	}
	for (const node of options.nodes) {
		const dependencies = new Set(node.dependencies ?? []);
		if (dependencies.size !== (node.dependencies ?? []).length) throw new Error(`Child ${node.id} has duplicate dependencies`);
		for (const dependency of dependencies) {
			if (dependency === node.id) throw new Error(`Child ${node.id} cannot depend on itself`);
			if (!byId.has(dependency)) throw new Error(`Child ${node.id} depends on unknown child ${dependency}`);
		}
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const walk = (id: string): void => {
		if (visiting.has(id)) throw new Error(`Orchestration dependency cycle includes ${id}`);
		if (visited.has(id)) return;
		visiting.add(id);
		for (const dependency of byId.get(id)?.dependencies ?? []) walk(dependency);
		visiting.delete(id);
		visited.add(id);
	};
	for (const id of byId.keys()) walk(id);

	const claims = new Map<string, WriteClaim>();
	for (const node of options.nodes) claims.set(node.id, await normalizeWriteClaim(options.workspaceRoot, node.permissionProfileId, node.writePaths));
	const reachable = new Map<string, Set<string>>();
	for (const source of byId.keys()) {
		const found = new Set<string>();
		const visitDependents = (id: string): void => {
			for (const candidate of options.nodes) if ((candidate.dependencies ?? []).includes(id) && !found.has(candidate.id)) {
				found.add(candidate.id);
				visitDependents(candidate.id);
			}
		};
		visitDependents(source);
		reachable.set(source, found);
	}
	for (let left = 0; left < options.nodes.length; left++) for (let right = left + 1; right < options.nodes.length; right++) {
		const a = options.nodes[left]!;
		const b = options.nodes[right]!;
		const ordered = reachable.get(a.id)?.has(b.id) || reachable.get(b.id)?.has(a.id);
		if (!ordered && writeClaimsOverlap(claims.get(a.id)!, claims.get(b.id)!)) {
			throw new Error(`Children ${a.id} and ${b.id} can run concurrently and have overlapping write paths`);
		}
	}
	return { byId, claims, reachable };
}

const MAXIMUM_CHILD_ERROR_BYTES = 2_000;

// Cuts text to at most maximumBytes UTF-8 bytes on a character boundary, marking the cut with an ellipsis.
const clipUtf8 = (text: string, maximumBytes: number): string => {
	const bytes = Buffer.from(text);
	if (bytes.length <= maximumBytes) return text;
	let end = Math.max(0, maximumBytes - 3);
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
	return `${bytes.subarray(0, end).toString("utf8")}…`;
};

// Names the first failing checks so the parent can tell why a child's run was rejected.
const verificationFailure = ({ checks }: VerificationResult): string => {
	const failing = checks.filter(({ passed }) => !passed).slice(0, 3).map(({ message }) => message);
	return clipUtf8(`Child result failed verification${failing.length ? `: ${failing.join("; ")}` : ""}`, MAXIMUM_CHILD_ERROR_BYTES);
};

export async function runOrchestration(options: OrchestrationOptions): Promise<OrchestrationResult> {
	const plan = await validatePlan(options);
	const writerLimit = options.maximumParallelWriters ?? MAXIMUM_PARALLEL_WRITERS;
	const results = new Map<string, OrchestrationNodeResult>();
	const pending = new Set(plan.byId.keys());
	const active = new Map<string, Promise<{ id: string; run?: RunResult; verified?: boolean; error?: unknown }>>();
	const emit = async (type: Extract<HarnessEventType, `subagent.${string}`>, data: Record<string, unknown>) => options.onEvent?.(type, data);
	for (const node of options.nodes) await emit("subagent.requested", { childId: node.id, presetId: node.presetId, dependencies: node.dependencies ?? [] });

	const launch = (node: OrchestrationNode) => {
		pending.delete(node.id);
		const claim = plan.claims.get(node.id)!;
		const verifiedDependencies = new Map((node.dependencies ?? []).flatMap((id) => {
			const result = results.get(id);
			return result?.status === "completed" && result.run ? [[id, result.run] as const] : [];
		}));
		const promise = (async () => {
			await emit("subagent.started", { childId: node.id, presetId: node.presetId, writeClaim: claim });
			try {
				const run = await options.execute(node, { delegationDepth: 1, writeClaim: claim, verifiedDependencies, signal: options.signal });
				if (run.capabilities.preset.id !== node.presetId) throw new Error(`Child changed preset from ${node.presetId} to ${run.capabilities.preset.id}`);
				if (run.capabilities.permissionProfileId !== node.permissionProfileId) throw new Error(`Child changed permission profile from ${node.permissionProfileId} to ${run.capabilities.permissionProfileId}`);
				if (!run.verification.passed) return { id: node.id, run, error: new Error(verificationFailure(run.verification)) };
				return { id: node.id, run, verified: true };
			} catch (error) {
				return { id: node.id, error };
			}
		})();
		active.set(node.id, promise);
	};

	while (pending.size || active.size) {
		if (options.signal?.aborted) throw new Error("Orchestration aborted");
		for (const id of [...pending]) {
			const node = plan.byId.get(id)!;
			const failedDependency = (node.dependencies ?? []).find((dependency) => results.get(dependency)?.status !== "completed");
			if (failedDependency && results.has(failedDependency)) {
				pending.delete(id);
				const result = { id, status: "skipped" as const, error: `Dependency ${failedDependency} did not complete` };
				results.set(id, result);
				await emit("subagent.failed", { childId: id, status: result.status, message: result.error });
			}
		}
		let activeWriters = [...active.keys()].filter((id) => {
			const claim = plan.claims.get(id)!;
			return claim.wholeWorkspace || claim.paths.length > 0;
		}).length;
		for (const node of options.nodes) {
			if (!pending.has(node.id) || !(node.dependencies ?? []).every((dependency) => results.get(dependency)?.status === "completed")) continue;
			const claim = plan.claims.get(node.id)!;
			const writer = claim.wholeWorkspace || claim.paths.length > 0;
			if (active.size >= MAXIMUM_CHILDREN_PER_RUN || (writer && activeWriters >= writerLimit)) continue;
			launch(node);
			if (writer) activeWriters++;
		}
		if (!active.size) {
			if (pending.size) throw new Error("Orchestration scheduler made no progress");
			break;
		}
		const completed = await Promise.race(active.values());
		active.delete(completed.id);
		if (completed.run && completed.verified) {
			results.set(completed.id, { id: completed.id, status: "completed", run: completed.run });
			await emit("subagent.completed", { childId: completed.id, runId: completed.run.runId, verified: true });
		} else {
			const message = completed.error instanceof Error ? completed.error.message : String(completed.error);
			// A run that failed verification is kept for inspection, but it never reaches dependents or synthesis.
			results.set(completed.id, { id: completed.id, status: "failed", ...(completed.run ? { run: completed.run } : {}), error: message });
			await emit("subagent.failed", { childId: completed.id, status: "failed", message });
		}
	}

	const verified = new Map<string, RunResult>();
	for (const node of options.nodes) {
		const result = results.get(node.id);
		if (result?.status === "completed" && result.run) verified.set(node.id, result.run);
	}
	const output = await options.synthesize(verified, options.signal);
	const verification = await options.verifyFinal(output, verified);
	const complete = results.size === options.nodes.length && [...results.values()].every(({ status }) => status === "completed");
	const finalVerification: VerificationResult = {
		...verification,
		passed: complete && verification.passed,
		checks: [
			...verification.checks,
			{ id: "all-required-children", passed: complete, message: complete ? "Every child completed with verified output" : "One or more required children failed or were skipped" },
		],
	};
	return { output, verification: finalVerification, children: options.nodes.map(({ id }) => results.get(id)!) };
}
