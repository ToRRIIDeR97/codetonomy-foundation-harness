// Sub-agent delegation as a harness module. The core never imports this package: callers
// enable it by passing createOrchestrationModule() in options.modules. The core supplies the
// options every child must inherit; this module schedules children and verifies the result.

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { redactAuditString, type HarnessEventType, type RunResult, type RunUsage, type VerificationResult } from "@agent-harness/contracts";
import { runOrchestration, type OrchestrationNode, type OrchestrationResult } from "@agent-harness/orchestration";
import { createHarness, resolveToolInterface, runtimeKnownSecrets, writeRuntimeFileAtomically, type HarnessModule, type HarnessModuleRunContext, type HarnessRunOptions } from "@agent-harness/runtime";
import { RunTrace } from "@agent-harness/telemetry";
import { ModuleToolError, truncateUtf8 } from "@agent-harness/tools";

export { MAXIMUM_CHILDREN_PER_RUN, MAXIMUM_DELEGATION_DEPTH, MAXIMUM_PARALLEL_WRITERS, normalizeWriteClaim, runOrchestration, writeClaimsOverlap, type OrchestrationNode, type OrchestrationResult, type WriteClaim } from "@agent-harness/orchestration";

export const DELEGATABLE_PRESET_IDS = [
	"general-assistant",
	"general-worker",
] as const;
export type DelegatablePresetId = (typeof DELEGATABLE_PRESET_IDS)[number];

export interface DelegateTasksNode {
	id: string;
	objective: string;
	presetId: DelegatablePresetId;
	permissionProfileId: "workspace-read" | "workspace-write";
	writePaths?: string[];
	dependencies?: string[];
}

export interface DelegateTasksChildResult {
	id: string;
	status: "completed" | "failed" | "skipped";
	runId?: string;
	output?: string;
	error?: string;
}

export interface DelegateTasksResult {
	output: string;
	verificationPassed: boolean;
	children: DelegateTasksChildResult[];
	/** For the parent runtime, not the model: files the completed children changed. */
	changedPaths?: string[];
	/** For the parent runtime, not the model: every child run's usage, summed. */
	additionalUsage?: RunUsage;
}

const sumUsage = (usages: readonly RunUsage[]): RunUsage => {
	const total: RunUsage = { reported: true, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	for (const usage of usages) {
		if (usage.reported === false) total.reported = false;
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.totalTokens += usage.totalTokens;
		if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
		if (usage.cost && total.cost) for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[key] += usage.cost[key];
		else if (usage.totalTokens > 0) delete total.cost;
	}
	return total;
};

const delegateTasksParameters = Type.Object({
	nodes: Type.Array(Type.Object({
		id: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" }),
		objective: Type.String({ minLength: 1, maxLength: 8_000 }),
		presetId: Type.Enum(DELEGATABLE_PRESET_IDS),
		permissionProfileId: Type.Union([Type.Literal("workspace-read"), Type.Literal("workspace-write")]),
		writePaths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), { maxItems: 32 })),
		dependencies: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" }), { maxItems: 3 })),
	}, { additionalProperties: false }), { minItems: 1, maxItems: 3 }),
}, { additionalProperties: false });

const delegateTasksDefinition = {
	name: "delegate_tasks",
	version: "1.0.0",
	description: "Run 1-3 bounded child agents in the foreground. Each child must name a preset and permission profile; children cannot delegate further. Requires user approval because it makes additional model calls.",
	parameters: delegateTasksParameters,
};

export interface HarnessOrchestrationOptions extends Omit<HarnessRunOptions, "objective" | "files" | "presetId" | "writePaths" | "verifiedDependencies" | "delegationDepth"> {
	nodes: OrchestrationNode[];
	parentPermissionProfileId: "workspace-read" | "workspace-write";
	maximumParallelWriters?: number;
	delegationDepth?: number;
	synthesize?(verifiedChildren: ReadonlyMap<string, RunResult>, signal?: AbortSignal): Promise<string>;
	verifyFinal?(output: string, verifiedChildren: ReadonlyMap<string, RunResult>): Promise<VerificationResult>;
	onSubagentEvent?(type: Extract<HarnessEventType, `subagent.${string}`>, data: Record<string, unknown>): void | Promise<void>;
}

export interface HarnessOrchestrationResult extends OrchestrationResult {
	runId: string;
	tracePath: string;
}

/** Runs 1-3 child agents as an orchestration run with its own trace and result file. */
export async function runHarnessOrchestration(options: HarnessOrchestrationOptions): Promise<HarnessOrchestrationResult> {
	if (options.toolInterface !== undefined && options.toolInterface !== "structured" && options.toolInterface !== "bash") throw new Error("Invalid toolInterface");
	if (options.maxDurationMs !== undefined && (!Number.isSafeInteger(options.maxDurationMs) || options.maxDurationMs < 1 || options.maxDurationMs > 86_400_000)) throw new Error("maxDurationMs must be 1-86400000");
	const startedAt = performance.now();
	const spendBudgetState = options.spendBudgetState ?? { maxCostUsd: options.maxCostUsd, maxTotalTokens: options.maxTotalTokens, costUsd: 0, totalTokens: 0 };
	const {
		nodes,
		parentPermissionProfileId,
		maximumParallelWriters,
		delegationDepth,
		synthesize,
		verifyFinal,
		onSubagentEvent,
		...runOptions
	} = options;
	const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
	const runId = randomUUID();
	const runDirectory = join(resolve(options.traceDirectory ?? ".harness/runs"), runId);
	const tracePath = join(runDirectory, "trace.jsonl");
	const knownSecrets = runtimeKnownSecrets(options.providerConfiguration);
	const trace = new RunTrace(runId, tracePath, options.observers, knownSecrets);
	const harness = createHarness();
	let runEventId: string | undefined;
	runOptions.runBudgetState ??= { deadline: Date.now() + (options.maxDurationMs ?? 1_800_000), modelTurns: 0, toolCalls: 0 };
	const deadlineController = new AbortController();
	const deadlineTimer = setTimeout(() => deadlineController.abort(new Error("Run deadline exceeded")), Math.max(0, runOptions.runBudgetState.deadline - Date.now()));
	const signal = AbortSignal.any([deadlineController.signal, ...(options.signal ? [options.signal] : [])]);

	try {
		const runEvent = await trace.emit("run.started", { repairSchemaVersion: 1, workspaceRoot, orchestration: true, permissionMode: options.permissionMode ?? "ask", toolInterface: resolveToolInterface(options) });
		runEventId = runEvent.eventId;
		const taskEvent = await trace.emit("task.compiled", { children: nodes }, runEventId);
		await trace.emit("capabilities.resolved", {
			maximumDelegationDepth: 1,
			maximumChildren: 3,
			maximumParallelWriters: maximumParallelWriters ?? 2,
			parentPermissionProfileId,
			delegationDepth,
		}, taskEvent.eventId);
		const result = await runOrchestration({
			workspaceRoot,
			nodes,
			parentPermissionProfileId,
			delegationDepth,
			...(maximumParallelWriters === undefined ? {} : { maximumParallelWriters }),
			signal,
			onEvent: async (type, data) => {
				await trace.emit(type, data, runEventId);
				await onSubagentEvent?.(type, data);
			},
			execute: (node, context) => harness.run({
				...runOptions,
				spendBudgetState,
				workspaceRoot,
				objective: node.objective,
				files: [...context.verifiedDependencies.values()].flatMap(({ artifacts }) => artifacts.flatMap(({ type, path }) => type === "file" && path ? [path] : [])),
				verifiedDependencies: context.verifiedDependencies,
				presetId: node.presetId,
				writePaths: node.writePaths,
				delegationDepth: context.delegationDepth,
				signal: context.signal,
			}),
			synthesize: synthesize ?? (async (children) => [...children.entries()]
				.map(([id, child]) => `## ${id}\n\n${child.output}`)
				.join("\n\n")),
			verifyFinal: verifyFinal ?? (async (output, children) => ({
				passed: Boolean(output.trim()) && children.size > 0,
				checks: [{
					id: "verified-synthesis",
					passed: Boolean(output.trim()) && children.size > 0,
					message: output.trim() && children.size ? "Synthesis contains verified child output" : "Synthesis has no verified child output",
				}],
			})),
		});
		const verificationEvent = await trace.emit("verification.started", { scope: "orchestration" }, runEventId);
		await trace.emit(result.verification.passed ? "verification.completed" : "verification.failed", { verification: result.verification }, verificationEvent.eventId);
		const finalResult = { ...result, runId, tracePath };
		await mkdir(runDirectory, { recursive: true });
		await writeRuntimeFileAtomically(join(runDirectory, "orchestration-result.json"), `${JSON.stringify(finalResult, null, 2)}\n`);
		await trace.emit(result.verification.passed ? "run.completed" : "run.failed", {
			verified: result.verification.passed,
			childRuns: result.children.flatMap(({ run }) => run ? [run.runId] : []),
			durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
		}, runEventId);
		return finalResult;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const safeMessage = redactAuditString(message, knownSecrets);
		await trace.emit("run.failed", { message: safeMessage }, runEventId);
		if (safeMessage !== message) throw new Error(safeMessage, { cause: error });
		throw error;
	} finally { clearTimeout(deadlineTimer); }
}

const DELEGATION_FAILURE = "Delegated child work failed verification";
// The runtime keeps only the first 2,000 characters of a tool error in the trace and the repair state.
const MAXIMUM_DELEGATION_FAILURE_BYTES = 2_000;

// Cuts text to at most maximumBytes UTF-8 bytes on a character boundary, marking the cut with an ellipsis.
const clipUtf8 = (text: string, maximumBytes: number): string => {
	const bytes = Buffer.from(text);
	if (bytes.length <= maximumBytes) return text;
	const marker = maximumBytes >= 3 ? "…" : "";
	let end = Math.max(0, maximumBytes - Buffer.byteLength(marker));
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
	return `${bytes.subarray(0, end).toString("utf8")}${marker}`;
};

// Names every failed or skipped child as `<id>=<status> (<reason>[; run <runId>])` within the error budget. Only
// reasons are shortened, and only as far as the shared budget needs, so every id, status and run id survives.
const delegationFailureMessage = ({ children, verification }: OrchestrationResult): string => {
	const unfinished = children.filter(({ status }) => status !== "completed");
	if (!unfinished.length) {
		const check = verification.checks.find(({ passed, message }) => !passed && message)?.message;
		return check ? clipUtf8(`${DELEGATION_FAILURE}: ${check}`, MAXIMUM_DELEGATION_FAILURE_BYTES) : DELEGATION_FAILURE;
	}
	const entry = ({ id, status, run }: typeof unfinished[number], reason: string) => `${id}=${status} (${reason}${run ? `; run ${run.runId}` : ""})`;
	const summary = (reasons: string[]) => `${DELEGATION_FAILURE}: ${unfinished.map((child, index) => entry(child, reasons[index]!)).join("; ")}`;
	const reasons = unfinished.map(({ error }) => error ?? "No reason recorded");
	// Water-fill the bytes left after the fixed parts: short reasons stay whole and long ones share the rest equally.
	let budget = MAXIMUM_DELEGATION_FAILURE_BYTES - Buffer.byteLength(summary(reasons.map(() => "")));
	const allowed: number[] = [];
	const bySize = reasons.map((reason, index) => ({ index, bytes: Buffer.byteLength(reason) })).sort((left, right) => left.bytes - right.bytes);
	for (const [position, { index, bytes }] of bySize.entries()) {
		allowed[index] = Math.min(bytes, Math.max(0, Math.floor(budget / (bySize.length - position))));
		budget -= allowed[index]!;
	}
	return summary(reasons.map((reason, index) => clipUtf8(reason, allowed[index]!)));
};

function delegateTasksTool(run: HarnessModuleRunContext | undefined): AgentTool<typeof delegateTasksParameters> {
	return {
		name: "delegate_tasks",
		label: "Delegate child agents",
		description: delegateTasksDefinition.description,
		parameters: delegateTasksParameters,
		executionMode: "sequential",
		async execute(_toolCallId, { nodes }, signal) {
			signal?.throwIfAborted();
			if (nodes.some(({ presetId }) => !DELEGATABLE_PRESET_IDS.includes(presetId))) throw new Error(`Unknown delegation preset; use one of: ${DELEGATABLE_PRESET_IDS.join(", ")}`);
			if (!run) throw new Error("delegate_tasks requires a parent run");
			if (run.depth >= 1) throw new Error("Recursive delegation is disabled");
			if (run.permissionProfileId !== "workspace-read" && run.permissionProfileId !== "workspace-write") throw new Error("Delegation requires a workspace permission profile");
			const orchestration = await runHarnessOrchestration({
				...(run.inheritedOptions as Omit<HarnessOrchestrationOptions, "nodes" | "parentPermissionProfileId">),
				nodes: nodes as OrchestrationNode[],
				parentPermissionProfileId: run.permissionProfileId,
				...(signal ? { signal } : {}),
			});
			signal?.throwIfAborted();
			const additionalUsage = sumUsage(orchestration.children.flatMap(({ run: child }) => child ? [child.usage] : []));
			// Failed children still spent tokens on the parent's behalf; the error carries that usage to the parent.
			if (!orchestration.verification.passed) throw new ModuleToolError(delegationFailureMessage(orchestration), additionalUsage);
			const children = orchestration.children.slice(0, 3).map(({ id, status, run: child, error }) => ({
				id,
				status,
				...(child ? { runId: child.runId } : {}),
				...(child?.output ? { output: truncateUtf8(child.output, 4_000).text } : {}),
				...(error ? { error: truncateUtf8(error, 1_000).text } : {}),
			}));
			// Reported to the parent run: files the verified children changed count as its workspace change,
			// and their usage is part of its usage (the shared spend budget already charged it).
			const completed = orchestration.children.flatMap(({ status, run: child }) => status === "completed" && child ? [child] : []);
			const visible = {
				output: truncateUtf8(orchestration.output, 16_000).text,
				verificationPassed: orchestration.verification.passed,
				children,
			};
			const details: DelegateTasksResult = {
				...visible,
				changedPaths: [...new Set(completed.flatMap(({ changedPaths }) => changedPaths ?? []))],
				additionalUsage,
			};
			const text = truncateUtf8(JSON.stringify(visible, null, 2)).text;
			return { content: [{ type: "text", text }], details };
		},
	};
}

/**
 * delegate_tasks on every top-level run: approval-gated because it makes more model calls,
 * and never offered to the children it starts, so delegation stays one level deep.
 */
export function createOrchestrationModule(): HarnessModule {
	return {
		id: "orchestration",
		tools: [{
			definition: delegateTasksDefinition,
			access: "approval",
			offer: "always",
			offerInChildRuns: false,
			promptLines: () => [
				"- To delegate, call delegate_tasks with one JSON object: {nodes:[{id,objective,presetId,permissionProfileId,writePaths?,dependencies?}]}. Submit 1-3 bounded children, use exact preset IDs, and declare write paths only for workspace-write children.",
				"- Child preset permissions are fixed: general-assistant uses workspace-read; general-worker uses workspace-write. A workspace-read parent cannot delegate a workspace-write child.",
				"- Delegation runs in the foreground and makes additional model calls, so it is approval-gated even for read-only parents. Child outputs are verified before they return; children cannot call delegate_tasks or expand the parent permission profile.",
			],
			create: ({ run }) => delegateTasksTool(run) as unknown as AgentTool,
		}],
	};
}
