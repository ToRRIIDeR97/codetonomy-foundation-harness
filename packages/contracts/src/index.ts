import { isAbsolute } from "node:path";

export type RiskClass = "low" | "medium" | "high";
export type PermissionDecision = "ALLOW" | "ASK" | "DENY";
export type ExecutionResultKind = "success" | "no-matches" | "failure";
export type WorkspaceMutationRisk = "none" | "possible";
export type CacheStrategy =
	| "AUTO_PREFIX"
	| "EXPLICIT_BREAKPOINT"
	| "NAMED_CONTEXT_OBJECT"
	| "SESSION_STATE"
	| "NO_PROVIDER_CACHE";

export interface AcceptanceCriterion {
	id: string;
	description: string;
	required: boolean;
	action?: "read" | "write" | "delete" | "exists" | "command" | "unsupported";
	target?: string;
	command?: string[];
	evidence?: "read-receipt" | "changed-state" | "file-state" | "zero-exit";
	/** Exact UTF-8 content supplied by the application or an explicit literal instruction. */
	expectedContent?: string;
}

export interface TaskInput {
	id: string;
	kind: "file" | "text" | "url";
	value: string;
}

export interface TaskSpecification {
	id: string;
	objective: string;
	inputs: TaskInput[];
	requiredCapabilities: string[];
	acceptanceCriteria: AcceptanceCriterion[];
	prohibitions?: Array<{ action: "command" | "write"; command?: string[]; target?: string }>;
	riskClass: RiskClass;
}

export interface AgentPreset {
	id: string;
	version: string;
	purpose: string;
	coreSkillIds: string[];
	toolIds: string[];
	permissionProfileId: string;
	verifierIds: string[];
	cacheStrategy: CacheStrategy;
}

export interface CompiledCapabilities {
	preset: AgentPreset;
	skillIds: string[];
	toolIds: string[];
	canonicalToolIds?: string[];
	permissionProfileId: string;
	verifierIds: string[];
	toolBundleHash: string;
	skillPackHash: string;
	contextPacketHash: string;
	cachePrefixHash: string;
	runProfileHash: string;
	/** Listed only to keep a session's cached prefix unchanged; calls to these are refused this turn. */
	carriedToolIds?: string[];
}

export interface PermissionProfile {
	id: string;
	defaultDecision: PermissionDecision;
	toolDecisions: Record<string, PermissionDecision>;
}

export interface ToolPermissionRequest {
	toolId: string;
	arguments: unknown;
	riskClass: RiskClass;
}

export interface VerificationCheck {
	id: string;
	passed: boolean;
	message: string;
}

export interface VerificationResult {
	passed: boolean;
	checks: VerificationCheck[];
	/** Number of content, artifact, or application checks, distinct from execution receipts. */
	outcomeChecks?: number;
}

export interface RunArtifact {
	id: string;
	type: "text" | "json" | "file";
	content: string;
	path?: string;
}

export interface RunUsage {
	/** False when any request lacks provider-reported usage; absent in legacy records. */
	reported?: boolean;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning?: number;
	totalTokens: number;
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cacheSavingsRatio?: number;
}

/** Pi reports uncached input, cache reads and cache writes as disjoint counts. */
export const promptTokenCount = (usage: Pick<RunUsage, "input" | "cacheRead" | "cacheWrite">): number => usage.input + usage.cacheRead + usage.cacheWrite;
export const cacheReadRatio = (usage: Pick<RunUsage, "input" | "cacheRead" | "cacheWrite" | "reported">): number | undefined =>
	usage.reported !== true || !promptTokenCount(usage) ? undefined : usage.cacheRead / promptTokenCount(usage);

export interface SkillManifest {
	id: string;
	version: string;
	description?: string;
	dependencies: string[];
	conflicts: string[];
	requiredCapabilities: string[];
	requiredTools: string[];
	requiredPermissions: string[];
	verifierIds: string[];
}

export interface ActivatedSkill {
	id: string;
	instructions: string;
	manifest?: SkillManifest;
}

export const MAX_CONVERSATION_PROMPT_BYTES = 64 * 1024;
export const MAX_SESSION_BYTES = 16 * 1024 * 1024;
export const MAX_SESSION_TURNS = 1000;

/** Private provider protocol history, including tool exchanges and signatures. */
export interface ConversationOutputRun {
	runId: string;
	tracePath: string;
	manifestSha256: string;
	outputIds: string[];
}

/** The tool list a session last exposed, so later turns can keep the same cached prefix. */
export interface SessionToolSet {
	presetId: string;
	permissionProfileId: string;
	toolInterface: "structured" | "bash";
	toolIds: string[];
	canonicalToolIds?: string[];
}

export interface ConversationTranscript { version: 1; messages: unknown[]; outputRuns?: ConversationOutputRun[]; toolSet?: SessionToolSet }

const TOOL_ID = /^[a-z][a-z0-9_]{0,63}$/;
const validToolIds = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 64
	&& value.every((id) => typeof id === "string" && TOOL_ID.test(id)) && new Set(value).size === value.length;

export function validateSessionToolSet(value: unknown): asserts value is SessionToolSet {
	const set = value as Partial<SessionToolSet> | undefined;
	if (!set || typeof set !== "object" || typeof set.presetId !== "string" || !TOOL_ID.test(set.presetId.replaceAll("-", "_"))
		|| typeof set.permissionProfileId !== "string" || !TOOL_ID.test(set.permissionProfileId.replaceAll("-", "_"))
		|| (set.toolInterface !== "structured" && set.toolInterface !== "bash") || !validToolIds(set.toolIds)
		|| (set.canonicalToolIds !== undefined && !validToolIds(set.canonicalToolIds))) throw new Error("Invalid session tool set");
}

export function validateConversationTranscript(value: unknown): asserts value is ConversationTranscript {
	const transcript = value as ConversationTranscript | undefined;
	if (!transcript || transcript.version !== 1 || !Array.isArray(transcript.messages)
		|| Buffer.byteLength(JSON.stringify(transcript)) > MAX_SESSION_BYTES) throw new Error("Invalid conversation transcript");
	if (transcript.toolSet !== undefined) validateSessionToolSet(transcript.toolSet);
	if (transcript.outputRuns !== undefined) {
		const ids = new Set<string>();
		const runs = new Set<string>();
		const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
		if (!Array.isArray(transcript.outputRuns) || transcript.outputRuns.length > MAX_SESSION_TURNS) throw new Error("Invalid transcript output references");
		for (const run of transcript.outputRuns) {
			if (!run || !uuid.test(run.runId) || runs.has(run.runId) || typeof run.tracePath !== "string" || !isAbsolute(run.tracePath) || run.tracePath.length > 32768
				|| !/^[0-9a-f]{64}$/.test(run.manifestSha256) || !Array.isArray(run.outputIds) || run.outputIds.length > 2048) throw new Error("Invalid transcript output reference");
			runs.add(run.runId);
			for (const id of run.outputIds) {
				if (!uuid.test(id) || ids.has(id)) throw new Error("Invalid transcript output ID");
				ids.add(id);
			}
		}
		if (ids.size > 20000) throw new Error("Too many transcript output references");
	}
	const pending = new Map<string, { name: string; requiresError: boolean }>();
	for (const raw of transcript.messages) {
		const message = raw as Record<string, any> | undefined;
		if (!message || !["user", "assistant", "toolResult"].includes(message.role) || !Number.isFinite(message.timestamp)) throw new Error("Invalid transcript message");
		if (typeof message.content === "string") {
			if (message.role !== "user") throw new Error("Invalid transcript content");
		} else {
			if (!Array.isArray(message.content)) throw new Error("Invalid transcript content");
			for (const block of message.content) {
				if (!block || typeof block !== "object") throw new Error("Invalid transcript block");
				if (block.type === "text" && typeof block.text === "string") continue;
				if (block.type === "thinking" && message.role === "assistant" && typeof block.thinking === "string") continue;
				if (block.type === "image" && message.role !== "assistant" && typeof block.data === "string" && typeof block.mimeType === "string") continue;
				const objectArguments = block.arguments && typeof block.arguments === "object" && !Array.isArray(block.arguments);
				const rejectedArguments = block.arguments === null || Array.isArray(block.arguments)
					|| ["string", "boolean"].includes(typeof block.arguments) || typeof block.arguments === "number" && Number.isFinite(block.arguments);
				if (block.type === "toolCall" && message.role === "assistant" && typeof block.id === "string" && typeof block.name === "string"
					&& (objectArguments || rejectedArguments) && !pending.has(block.id)) {
					// Protocol history includes calls rejected before execution, including
					// the SDK's null marker for malformed JSON. Retain the paired error.
					pending.set(block.id, { name: block.name, requiresError: !objectArguments || block.argumentParseStatus === "invalid" });
					continue;
				}
				throw new Error("Invalid transcript block");
			}
		}
		if (message.role === "assistant" && (![message.api, message.provider, message.model, message.stopReason].every(item => typeof item === "string") || !message.usage)) throw new Error("Invalid transcript assistant");
		if (message.role === "toolResult") {
			const call = pending.get(message.toolCallId);
			if (!call || call.name !== message.toolName || typeof message.isError !== "boolean") throw new Error("Unpaired transcript tool result");
			if (call.requiresError && !message.isError) throw new Error("Rejected transcript arguments require an error result");
			pending.delete(message.toolCallId);
		}
	}
	if (pending.size) throw new Error("Unpaired transcript tool call");
}

export interface ConversationTurn {
	runId: string;
	objective: string;
	/** Exact rendered user text when retained; older sessions keep objective only. */
	prompt?: string;
	output: string;
	timestamp: number;
	checkpointPath?: string;
	reasoning?: ReasoningTrace[];
	usage?: RunUsage;
	modelContext?: RunModelContext;
	model?: string;
	durationMs?: number;
}

export interface ReasoningTrace { text: string; truncated: boolean }
export interface RunModelContext { contextWindow: number; maxOutputTokens: number; lastPromptTokens: number; promptTokensReported?: boolean }
export interface ModelStreamUpdate { kind: "reasoning" | "text"; text: string }

export interface ConversationProjection {
	turns: ConversationTurn[];
	omittedTurns: number;
	estimatedBytes: number;
	projectionHash: string;
}

/** Unresolved unknown-effects mutation retained across an interruption. */
export interface RunRecoveryMutation {
	/** Canonical operation id from the interrupted run. */
	toolName: string;
	/** Bounded failure detail; the runtime redacts it before recording. */
	message: string;
	/** Absolute workspace target when the operation had one. */
	target?: string;
	outcome: "effects-unknown";
	/** Required validation command retained for trusted reconciliation. */
	retryCommand?: string[];
	retryCwd?: string;
	optionalDiagnostic?: boolean;
	corrected?: boolean;
	correctionRevisions?: Record<string, string>;
	/** Failure event id from the interrupted run; parents later resolutions. */
	failureEventId?: string;
	obligationId?: string;
}

/** Aggregate spend projection, including reservations that never settled. */
export interface RunRecoverySpend {
	maxCostUsd?: number;
	maxTotalTokens?: number;
	costUsd: number;
	totalTokens: number;
	reservedCostUsd?: number;
	reservedTokens?: number;
	/** True while tracked usage remains provider-unreported; never clears on reload. */
	usageUnknown?: boolean;
}

/**
 * Private session-scoped projection of run-local recovery state. It never
 * implies success: resumed mutation attempts stay blocked until the existing
 * trusted reconciliation checks resolve every uncertain mutation, and unknown
 * spend stays unknown with budget limits applied conservatively.
 */
export interface RunRecoveryState {
	version: 1;
	uncertainMutations: RunRecoveryMutation[];
	spend: RunRecoverySpend;
}

export const MAX_RECOVERY_UNCERTAIN_MUTATIONS = 64;

const RECOVERY_EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateRunRecoveryState(value: unknown): asserts value is RunRecoveryState {
	const state = value as Partial<RunRecoveryState> | undefined;
	if (!state || typeof state !== "object" || Array.isArray(state) || state.version !== 1
		|| !Array.isArray(state.uncertainMutations) || state.uncertainMutations.length > MAX_RECOVERY_UNCERTAIN_MUTATIONS
		|| !state.spend || typeof state.spend !== "object" || Array.isArray(state.spend)) throw new Error("Invalid recovery state");
	const spend = state.spend;
	if (!Number.isFinite(spend.costUsd) || spend.costUsd < 0 || !Number.isSafeInteger(spend.totalTokens) || spend.totalTokens < 0
		|| (spend.reservedCostUsd !== undefined && (!Number.isFinite(spend.reservedCostUsd) || spend.reservedCostUsd < 0))
		|| (spend.reservedTokens !== undefined && (!Number.isSafeInteger(spend.reservedTokens) || spend.reservedTokens < 0))
		|| (spend.maxCostUsd !== undefined && (!Number.isFinite(spend.maxCostUsd) || spend.maxCostUsd <= 0))
		|| (spend.maxTotalTokens !== undefined && (!Number.isSafeInteger(spend.maxTotalTokens) || spend.maxTotalTokens < 1))
		|| (spend.usageUnknown !== undefined && typeof spend.usageUnknown !== "boolean")) throw new Error("Invalid recovery spend state");
	for (const mutation of state.uncertainMutations) {
		const revisions = mutation?.correctionRevisions;
		if (!mutation || typeof mutation !== "object" || Array.isArray(mutation)
			|| typeof mutation.toolName !== "string" || !mutation.toolName || mutation.toolName.length > 128
			|| typeof mutation.message !== "string" || !mutation.message || mutation.message.length > 1_000
			|| mutation.outcome !== "effects-unknown"
			|| (mutation.target !== undefined && (typeof mutation.target !== "string" || !mutation.target || mutation.target.length > 4_096 || !isAbsolute(mutation.target)))
			|| (mutation.retryCommand !== undefined && (!Array.isArray(mutation.retryCommand) || !mutation.retryCommand.length || mutation.retryCommand.length > 32
				|| mutation.retryCommand.some((entry) => typeof entry !== "string" || !entry || entry.length > 512)))
			|| (mutation.retryCwd !== undefined && (typeof mutation.retryCwd !== "string" || !mutation.retryCwd || mutation.retryCwd.length > 4_096 || !isAbsolute(mutation.retryCwd)))
			|| (mutation.optionalDiagnostic !== undefined && typeof mutation.optionalDiagnostic !== "boolean")
			|| (mutation.corrected !== undefined && typeof mutation.corrected !== "boolean")
			|| (mutation.failureEventId !== undefined && (typeof mutation.failureEventId !== "string" || !RECOVERY_EVENT_ID.test(mutation.failureEventId)))
			|| (mutation.obligationId !== undefined && (typeof mutation.obligationId !== "string" || !mutation.obligationId || mutation.obligationId.length > 128))
			|| (revisions !== undefined && (!revisions || typeof revisions !== "object" || Array.isArray(revisions)
				|| Object.keys(revisions).length > MAX_RECOVERY_UNCERTAIN_MUTATIONS
				|| Object.entries(revisions).some(([target, revision]) => typeof target !== "string" || !target || target.length > 4_096 || !isAbsolute(target)
					|| typeof revision !== "string" || !revision || revision.length > 128)))) {
			throw new Error("Invalid recovery mutation");
		}
	}
}

export interface RunResult {
	runId: string;
	task: TaskSpecification;
	capabilities: CompiledCapabilities;
	output: string;
	artifacts: RunArtifact[];
	verification: VerificationResult;
	usage: RunUsage;
	tracePath: string;
	checkpointPath?: string;
	contextPacket?: ContextPacket;
	reasoning?: ReasoningTrace[];
	modelContext?: RunModelContext;
	model?: string;
	durationMs?: number;
	/** Workspace-relative paths the run (or verified work it delegated) wrote or deleted, still current at the end. */
	changedPaths?: string[];
	/** Recovery projection for session resume; never implies a successful run. */
	recovery?: RunRecoveryState;
}

export interface RunStore {
	saveRun(run: RunResult, metadata?: { parentRunId?: string; childId?: string }): Promise<void>;
}

export const HARNESS_EVENT_TYPES = [
	"run.started",
	"run.completed",
	"run.failed",
	"task.compiled",
	"capabilities.resolved",
	"context.compiled",
	"context.prepared",
	"budget.reconciled",
	"module.recall.started",
	"module.recall.completed",
	"module.recall.failed",
	"module.capture.started",
	"module.capture.completed",
	"module.capture.failed",
	"model.profile.resolved",
	"model.request.started",
	"model.first_token",
	"model.reasoning.completed",
	"model.request.completed",
	"model.request.failed",
	"provider.attempt.started",
	"provider.attempt.completed",
	"provider.attempt.failed",
	"provider.retry.scheduled",
	"cache.lookup",
	"cache.read",
	"cache.write",
	"cache.invalidated",
	"tool.requested",
	"tool.allowed",
	"tool.denied",
	"tool.started",
	"tool.completed",
	"tool.failed",
	"tool.output.invalidated",
	"tool.failure.resolved",
	"tool.failure.superseded",
	"repair.worker.started",
	"repair.worker.completed",
	"repair.worker.skipped",
	"subagent.requested",
	"subagent.started",
	"subagent.completed",
	"subagent.failed",
	"verification.started",
	"verification.completed",
	"verification.failed",
	"artifact.created",
	"artifact.updated",
	"artifact.rejected",
] as const;

export type HarnessEventType = (typeof HARNESS_EVENT_TYPES)[number];

export interface HarnessEvent {
	eventId: string;
	runId: string;
	parentEventId?: string;
	sequence: number;
	timestamp: string;
	type: HarnessEventType;
	data: Record<string, unknown>;
}

export interface RunObserver {
	(event: HarnessEvent): void | Promise<void>;
}

export interface ContextPacket {
	taskId: string;
	agentPresetId: string;
	structuralContext: unknown[];
	evidence: unknown[];
	memories: unknown[];
	sourceVersions: unknown[];
	provenance: unknown[];
	tokenBudget: number;
	estimatedTokens: number;
	contextHash: string;
}

export interface CacheCapabilities {
	strategies: CacheStrategy[];
	supportsUsageReporting: boolean;
}

const SENSITIVE_WORKSPACE_PATH = /(?:^|\/)(?:(?:\.ssh|\.aws|\.gnupg)(?:\/[\s\S]*)?|\.kube\/config|\.env(?:\..*)?|\.(?:npmrc|pypirc|netrc)|(?:credentials?|secrets?)\.(?:json|ya?ml|toml|ini|conf|txt)|id_[^.\/]+|[^/]+\.(?:key|pem|p12|pfx|keystore))$/i;

export const isSensitiveWorkspacePath = (path: string): boolean =>
	SENSITIVE_WORKSPACE_PATH.test(path.replaceAll("\\", "/").replace(/^\.\//, ""));

const SENSITIVE_AUDIT_KEY = /^(?:api[_-]?key|authorization|cookie|credential|password|private[_-]?key|secret|token|content|oldText|newText)$/i;

export const redactAuditString = (value: string, knownSecrets: readonly string[] = []): string => {
	let redacted = value
		.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}/gi, "Bearer [REDACTED]")
		.replace(/\b(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTHORIZATION|COOKIE|PASSWORD|SECRET|TOKEN)\s*[:=]\s*[^\s,;]+/gi, (match) => `${match.slice(0, match.search(/[:=]/) + 1)}[REDACTED]`)
		.replace(/((?:"|')?(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTHORIZATION|COOKIE|CREDENTIAL|PASSWORD|PRIVATE[_-]?KEY|SECRET|TOKEN)(?:"|')?\s*:\s*(["']))(?:\\.|(?!\2)[^\\\r\n])*\2/gi, "$1[REDACTED]$2")
		.replace(/([?&](?:api[_-]?key|access[_-]?token|key|signature|token)=)[^&#\s]+/gi, "$1[REDACTED]")
		.replace(/\bhttps?:\/\/[^\s/@:]+:[^\s/@]+@/gi, (match) => `${match.slice(0, match.indexOf("://") + 3)}[REDACTED]@`)
		.replace(/\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|(?:sk|key|token)-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED]");
	for (const secret of new Set(knownSecrets.filter((candidate) => candidate.length >= 4))) redacted = redacted.replaceAll(secret, "[REDACTED]");
	return redacted;
};

export const redactAuditValue = (value: unknown, key = "", knownSecrets: readonly string[] = []): unknown => {
	if (SENSITIVE_AUDIT_KEY.test(key)) return "[REDACTED]";
	if (typeof value === "string") return redactAuditString(value, knownSecrets);
	if (Array.isArray(value)) return value.map((item) => redactAuditValue(item, "", knownSecrets));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, redactAuditValue(item, childKey, knownSecrets)]));
	return value;
};

/** Redacts secrets and escapes control characters before text reaches a terminal. */
export function sanitizeTerminalText(value: string): string {
	return redactAuditString(value).replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, (character) => {
		return `\\u{${character.codePointAt(0)?.toString(16).padStart(2, "0")}}`;
	});
}

// Wide East Asian ranges and emoji take two terminal cells; marks and joiners take none.
const doubleWidth = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3fffd}]|\p{Emoji_Presentation}/u;
const zeroWidth = /[\p{M}​-‏︀-️]/u;

/** Cuts single-line text so it occupies at most `columns` terminal cells; a line that would wrap cannot be redrawn in place. */
export function fitTerminalWidth(value: string, columns: number): string {
	let used = 0;
	let fitted = "";
	for (const character of value) {
		const cells = zeroWidth.test(character) ? 0 : doubleWidth.test(character) ? 2 : 1;
		if (used + cells > columns) break;
		used += cells;
		fitted += character;
	}
	return fitted;
}
