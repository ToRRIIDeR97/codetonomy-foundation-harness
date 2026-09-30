import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
	createProvider,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	lazyApi,
	validateToolArguments,
	type Api,
	type Context,
	type AssistantMessage,
	type FauxResponseStep,
	type Message,
	type Model,
	type Provider,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { buildStableSystemPrompt, buildToolBundleHash, resolveCapabilities, stableHash, type ToolInterface } from "@agent-harness/capability-compiler";
export type { ToolInterface } from "@agent-harness/capability-compiler";
import { effectiveActionNudgeMode, effectiveReasoningLevel, resolveModelProfile, type ActionNudgeMode } from "./model-profiles.js";
import { resumableCheckpointMessages } from "./session-checkpoint.js";
export { effectiveActionNudgeMode, effectiveReasoningLevel, HARNESS_DEFAULT_ACTION_NUDGE_MODE, HARNESS_DEFAULT_REASONING_LEVEL, MODEL_PROFILES, resolveModelProfile, validateModelProfiles, type ActionNudgeMode, type ModelProfile, type ReasoningLevel, type ResolvedModelProfile } from "./model-profiles.js";
import { compileContext, renderContextTail } from "@agent-harness/context-compiler";
import { isSensitiveWorkspacePath, redactAuditString, type ActivatedSkill, type CacheCapabilities, type ConversationProjection, type ConversationTurn, type HarnessEvent, type ModelStreamUpdate, type ReasoningTrace, type RunArtifact, type RunModelContext, type RunObserver, type RunRecoveryState, type RunResult, type RunStore, type RunUsage, type TaskSpecification, type VerificationResult } from "@agent-harness/contracts";
import { getPermissionProfile, isPermissionMode, PermissionGate, type ApprovalHandler, type PermissionMode } from "@agent-harness/permissions";
import { compileTask, type CompileTaskInput } from "@agent-harness/task-compiler";
import { RunTrace } from "@agent-harness/telemetry";
import { MAX_CONVERSATION_PROMPT_BYTES, MAX_SESSION_BYTES, MAX_SESSION_TURNS, promptTokenCount, cacheReadRatio, validateConversationTranscript, type ConversationTranscript } from "@agent-harness/contracts";
import { BashCommandPlanner, bashOperationHasPreciseCommand, bashPermissionTarget, bashPermissionTargets, bashPlanUsesReadOnlySandbox, CODING_TOOL_IDS, CommandOutputStore, createNativeBashArgv, normalizeWriteClaim, resolveToolCacheDefinitions, resolveTools, TOOL_OUTPUT_MANIFEST, moduleTools as listModuleTools, type BashCommandPlan, type BashToolArguments, type CommandMutationRisk, type CommandResultKind, type HarnessModule, type HarnessModuleRunContext, type HarnessModuleTool } from "@agent-harness/tools";
export type { HarnessModule, HarnessModuleRunContext, HarnessModuleTool, HarnessModuleToolContext, HarnessModuleToolDefinition, RecalledContext } from "@agent-harness/tools";
export { SANDBOX_INSTALL_HINT, sandboxInstalled } from "@agent-harness/tools";
import { commandMatches, verifyOutput } from "@agent-harness/verifiers";
import { captureCacheShape, classifyCacheMiss, commonPrefixBytes, deriveCacheAffinityId, lookupAndStoreCacheShape, observeWireRequest, type WireRequestObservation } from "./cache-shape.js";
import { RunCheckpoint, writeRuntimeFileAtomically } from "./checkpoint.js";
import { mutationFromRecoverableError, recoverableErrorFromMutation, type RecoverableToolError } from "./recovery-mutation.js";
import { verifyRunAttempt } from "./run-verification.js";
import { validateRunOptions } from "./run-options.js";
import { decideNextTurnNudge, initialNudgePolicyState, TRUNCATION_ACTION_NUDGE_TEXT, TRUNCATION_DISCOVERY_NUDGE_TEXT } from "./nudge-policy.js";
import { createRequestAccounting, prepareRequest, releaseReservation, requestReservation, reserveRequests, type Reservation, type RunSpendBudgetState } from "./request-budget.js";
import {
	classifyRepairFailure,
	createRepairContext,
	createRepairPacket,
	createRepairReceipt,
	parseRepairResponse,
	renderRepairReceipts,
	validateRepairProposal,
	type RepairFailureCandidate,
	type RepairReceipt,
	type RepairWorkerOptions,
} from "./repair-worker.js";
export { RequestAdmissionError } from "./request-budget.js";
export type { RunSpendBudgetState } from "./request-budget.js";
export type { RepairWorkerContext, RepairWorkerOptions } from "./repair-worker.js";

export { previewCheckpoint, rewindCheckpoint, writeRuntimeFileAtomically, type CheckpointPreview, type RewindResult } from "./checkpoint.js";
export { isPermissionMode, permissionModes } from "@agent-harness/permissions";
export type { PermissionMode } from "@agent-harness/permissions";

export interface HarnessRunOptions extends CompileTaskInput {
	permissionMode?: PermissionMode;
	delegationDepth?: number;
	workspaceRoot?: string;
	traceDirectory?: string;
	provider?: string;
	modelId?: string;
	providerConfiguration?: HarnessProviderConfiguration;
	signal?: AbortSignal;
	activatedSkills?: ActivatedSkill[];
	observers?: RunObserver[];
	approve?: ApprovalHandler;
	conversation?: ConversationTurn[];
	transcript?: ConversationTranscript;
	/** Private session checkpoint; never written to telemetry or result exports. */
	onTranscript?(transcript: ConversationTranscript): void;
	/**
	 * Private session persistence only: publishes the validated recovery
	 * projection on both success and failure paths, including held spend
	 * reservations and unresolved unknown-effects mutations.
	 */
	onRecovery?(recovery: RunRecoveryState): void;
	/** Trusted recovery state from the previous run of this session. */
	recoveryState?: RunRecoveryState;
	cacheRetention?: "none" | "short" | "long";
	/** Soft input threshold for compacting recoverable history. User instructions are never discarded. */
	contextRetentionTokens?: number;
	/** Optional trusted tokenizer for the selected model; fallback is explicitly estimated. */
	contextTokenCounter?(context: Context): number;
	sessionId?: string;
	/** Optional local scope for provider cache affinity; never sent verbatim. */
	cacheAffinityId?: string;
	providerFetch?: typeof globalThis.fetch;
	/**
	 * Modules add read-only tools, recalled context and after-run hooks. They are
	 * fixed for the run and passed on to delegated children.
	 */
	modules?: readonly HarnessModule[];
	/** Token budget for module-recalled context; defaults to 4000. */
	contextTokenBudget?: number;
	presetId?: string;
	writePaths?: string[];
	verifiedDependencies?: ReadonlyMap<string, RunResult>;
	runStore?: RunStore;
	evaluationVariant?: HarnessEvaluationVariant;
	toolInterface?: ToolInterface;
	/** Heuristic narrowing is opt-in; the existing preset bundle remains the default. */
	toolSelection?: "minimal" | "preset";
	/** Trusted application configuration, never derived from tool/model output. */
	application?: HarnessApplication;
	maxOutputTokens?: number;
	maxModelTurns?: number;
	maxToolCalls?: number;
	maxDurationMs?: number;
	runBudgetState?: { deadline: number; modelTurns: number; toolCalls: number };
	providerRetryLimit?: number;
	providerMaxRetryDelayMs?: number;
	maxCostUsd?: number;
	maxTotalTokens?: number;
	spendBudgetState?: RunSpendBudgetState;
	reasoningLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	/** Overrides the model profile's proactive action-nudge mode; see ActionNudgeMode. */
	actionNudgeMode?: ActionNudgeMode;
	repairWorker?: RepairWorkerOptions;
	onStream?(update: ModelStreamUpdate): void;
	/** Private session persistence only; rendered instructions are not added to run telemetry. */
	onUserPrompt?(prompt: string): void;
	onProviderResponse?: (response: { status: number; headers: Record<string, string> }) => void | Promise<void>;
	images?: HarnessImageInput[];
}

export const resolveToolInterface = (options: Pick<HarnessRunOptions, "toolInterface">): ToolInterface =>
	options.toolInterface ?? "structured";

export interface HarnessApplication {
	id: string;
	toolIds?: string[];
	compileTask?(input: CompileTaskInput): TaskSpecification;
	verify(input: { task: TaskSpecification; output: string; artifacts: RunArtifact[]; workspaceRoot: string; signal?: AbortSignal }): Promise<VerificationResult>;
}

export interface HarnessImageInput { data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" }

export type HarnessEvaluationVariant =
	| "RAW_MODEL"
	| "MODEL_TOOLS"
	| "MODEL_SKILLS"
	| "MODEL_SKILLS_TOOLS"
	| "MODEL_SKILLS_TOOLS_VERIFIERS"
	| "FULL_PRESET";

export interface AgentHarness {
	run(options: HarnessRunOptions): Promise<RunResult>;
}

export type HarnessProviderKind =
	| "openai"
	| "anthropic"
	| "google"
	| "deepseek"
	| "openrouter"
	| "opencode"
	| "opencode-go"
	| "openai-compatible"
	| "anthropic-compatible";

export const cacheCapabilitiesForProvider = (kind: HarnessProviderKind | "fixture"): CacheCapabilities => ({
	strategies: kind === "anthropic" || kind === "anthropic-compatible"
		? ["EXPLICIT_BREAKPOINT"]
		: kind === "fixture"
			? ["NO_PROVIDER_CACHE"]
			: ["AUTO_PREFIX"],
	supportsUsageReporting: kind !== "fixture" && !kind.endsWith("-compatible"),
});

export interface HarnessProviderConfiguration {
	id: string;
	name: string;
	kind: HarnessProviderKind;
	baseUrl?: string;
	apiKey?: string;
	modelMetadata?: HarnessModelMetadata;
}

export interface HarnessModelMetadata {
	id: string;
	name: string;
	api: "anthropic-messages" | "google-generative-ai" | "openai-completions" | "openai-responses";
	reasoning: boolean;
	input: Array<"text" | "image">;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	cacheStrategy?: "AUTO_PREFIX" | "EXPLICIT_BREAKPOINT" | "NO_PROVIDER_CACHE";
	cacheRetention?: "none" | "short" | "long";
	contextRetentionTokens?: number;
	thinkingFormat?: "openai" | "deepseek" | "zai" | "qwen" | "qwen-chat-template";
}

/** Values the trace must redact for this provider configuration: its API key and secret-looking environment variables. */
export const runtimeKnownSecrets = (configuration?: HarnessProviderConfiguration): string[] => [...new Set([
	...(configuration?.apiKey ? [configuration.apiKey] : []),
	...Object.entries(process.env).flatMap(([name, value]) => /(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD)$/.test(name) && (value?.length ?? 0) >= 8 ? [value!] : []),
])];

const readRuntimeSource = async (path: string, signal?: AbortSignal): Promise<{ hash: string; content?: string }> => {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.nlink !== 1 || before.size > 50 * 1024 * 1024) throw new Error("Source is not a bounded standalone file");
		const digest = createHash("sha256");
		const chunks: Buffer[] = [];
		let position = 0;
		while (position <= before.size) {
			signal?.throwIfAborted();
			const chunk = Buffer.alloc(Math.min(64 * 1024, before.size + 1 - position));
			if (!chunk.length) break;
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
			if (!bytesRead) break;
			const bytes = chunk.subarray(0, bytesRead);
			digest.update(bytes);
			if (before.size <= 2 * 1024 * 1024) chunks.push(bytes);
			position += bytesRead;
		}
		const after = await handle.stat();
		if (position !== before.size || `${before.dev}:${before.ino}:${before.ctimeMs}:${before.size}` !== `${after.dev}:${after.ino}:${after.ctimeMs}:${after.size}`) throw new Error("Source changed while reading");
		let content: string | undefined;
		if (chunks.length || before.size === 0) try { content = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); } catch {}
		return { hash: digest.digest("hex"), ...(content === undefined ? {} : { content }) };
	} finally { await handle.close(); }
};

const DEFAULT_MODELS: Record<string, string> = {
	fixture: "faux-1",
	openai: "gpt-5.4-mini",
	anthropic: "claude-sonnet-4-6",
	google: "gemini-3.5-flash",
	deepseek: "deepseek-v4-flash",
	openrouter: "~openai/gpt-mini-latest",
	opencode: "kimi-k2.6",
	"opencode-go": "kimi-k2.6",
};

const builtinProvider = (id: string): Provider | undefined => {
	switch (id) {
		case "openai": return openaiProvider();
		case "anthropic": return anthropicProvider();
		case "google": return googleProvider();
		case "deepseek": return deepseekProvider();
		case "openrouter": return openrouterProvider();
		case "opencode": return opencodeProvider();
		case "opencode-go": return opencodeGoProvider();
		default: return undefined;
	}
};

export const supportedModelsForProvider = (kind: HarnessProviderKind): string[] | undefined =>
	builtinProvider(kind)?.getModels().map(({ id }) => id);

/** The environment variable pi-ai would read for a built-in provider's credential, or undefined when none is set. */
export const providerCredentialSource = async (kind: HarnessProviderKind): Promise<string | undefined> => {
	const provider = builtinProvider(kind);
	if (!provider) return undefined;
	const models = createModels();
	models.setProvider(provider);
	return (await models.checkAuth(kind))?.source;
};

// Pi's Google adapters use Google's SDK and reject a custom fetch, so wire observation
// and budget admission for them run on the serialized payload through onPayload instead.
const FETCHLESS_APIS: ReadonlySet<string> = new Set(["google-generative-ai", "google-vertex"]);
const providerTransport = (api: string, requestFetch: typeof fetch, beforeSend: (body: string) => Promise<void>) => {
	if (!FETCHLESS_APIS.has(api)) return { options: { fetch: requestFetch }, attemptStarted: async () => {} };
	let payload: string | undefined;
	return {
		options: { onPayload: async (value: unknown) => { payload = JSON.stringify(value); return undefined; } },
		// Pi awaits each attempt's start after onPayload and before sending, where a reservation exists.
		attemptStarted: async () => { if (payload !== undefined) await beforeSend(payload); },
	};
};

const modelFromProvider = (provider: Provider, kind: HarnessProviderKind, modelId: string, metadata?: HarnessModelMetadata): Model<Api> | undefined => {
	const known = provider.getModels().find(({ id }) => id === modelId);
	const { protocol } = resolveModelProfile({ provider: kind, modelId });
	// A profile's effort map follows the provider's documentation, so it also corrects catalogue models.
	if (!metadata || metadata.id !== modelId || kind !== "opencode-go") return known && protocol.thinkingLevelMap ? { ...known, thinkingLevelMap: protocol.thinkingLevelMap } : known;
	const baseUrl = metadata.api === "anthropic-messages" ? "https://opencode.ai/zen/go" : "https://opencode.ai/zen/go/v1";
	const compat = known?.compat ?? (metadata.api === "openai-responses"
		? { sessionAffinityFormat: "openai-nosession" as const }
		: metadata.api === "openai-completions"
			? { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" as const, ...protocol.completionsCompat }
			: undefined);
	return {
		...known,
		...metadata,
		provider: provider.id,
		baseUrl,
		...(protocol.thinkingLevelMap ? { thinkingLevelMap: protocol.thinkingLevelMap } : {}),
		...(compat ? { compat } : {}),
	} as Model<Api>;
};

const validateProviderConfiguration = (configuration: HarnessProviderConfiguration): void => {
	if (!/^[a-z][a-z0-9-]{0,63}$/.test(configuration.id)) throw new Error(`Invalid provider id: ${configuration.id}`);
	if (!configuration.name.trim() || configuration.name.length > 80) throw new Error("Provider name must be 1-80 characters");
	if (configuration.apiKey && (configuration.apiKey.length > 16 * 1024 || /[\r\n]/.test(configuration.apiKey))) {
		throw new Error(`Invalid API key for ${configuration.id}`);
	}
	if (configuration.modelMetadata) {
		const model = configuration.modelMetadata;
		if ((!configuration.kind.endsWith("-compatible") && configuration.kind !== "opencode-go") || !/^[A-Za-z0-9~][A-Za-z0-9._:/~-]{0,191}$/.test(model.id) || !model.name.trim() || model.name.length > 160
			|| !["anthropic-messages", "google-generative-ai", "openai-completions", "openai-responses"].includes(model.api)
			|| typeof model.reasoning !== "boolean"
			|| !model.input.length || model.input.some((input) => input !== "text" && input !== "image")
			|| ![model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite].every((value) => Number.isFinite(value) && value >= 0)
			|| !Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1
			|| !Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1 || model.maxTokens > model.contextWindow
			|| (model.cacheStrategy !== undefined && !["AUTO_PREFIX", "EXPLICIT_BREAKPOINT", "NO_PROVIDER_CACHE"].includes(model.cacheStrategy))
			|| (model.thinkingFormat !== undefined && !["openai", "deepseek", "zai", "qwen", "qwen-chat-template"].includes(model.thinkingFormat))) {
			throw new Error(`Invalid model metadata for ${configuration.id}/${model.id}`);
		}
	}
	if (configuration.kind.endsWith("-compatible")) {
		if (!configuration.baseUrl) throw new Error(`${configuration.name} requires a base URL`);
		const url = new URL(configuration.baseUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Provider base URL must use HTTP or HTTPS");
		if (url.username || url.password || url.search || url.hash) throw new Error("Provider base URL cannot contain credentials, query parameters, or fragments");
		if (url.protocol === "http:" && !["127.0.0.1", "::1", "localhost"].includes(url.hostname)) throw new Error("Remote provider base URLs must use HTTPS");
	} else if (configuration.id !== configuration.kind) {
		throw new Error(`Built-in provider ${configuration.kind} must use id ${configuration.kind}`);
	}
};

const customProvider = (configuration: HarnessProviderConfiguration, modelId: string): Provider => {
	validateProviderConfiguration(configuration);
	const metadata = configuration.modelMetadata;
	if (metadata && (metadata.id !== modelId || metadata.api !== (configuration.kind === "anthropic-compatible" ? "anthropic-messages" : "openai-completions"))) throw new Error("Custom model metadata does not match the selected model or endpoint protocol");
	const api: Api = configuration.kind === "anthropic-compatible" ? "anthropic-messages" : "openai-completions";
	const model: Model<Api> = {
		id: modelId,
		name: modelId,
		api,
		provider: configuration.id,
		baseUrl: configuration.baseUrl!,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 128_000,
		...metadata,
		...(metadata?.thinkingFormat ? { compat: { thinkingFormat: metadata.thinkingFormat, supportsReasoningEffort: metadata.thinkingFormat === "openai" } } : {}),
	};
	return createProvider({
		id: configuration.id,
		name: configuration.name,
		baseUrl: configuration.baseUrl,
		auth: {
			apiKey: {
				name: `${configuration.name} API key`,
				resolve: async ({ credential, signal }) => {
					signal.throwIfAborted();
					return { auth: credential?.key ? { apiKey: credential.key } : {} };
				},
			},
		},
		models: [model],
		api: configuration.kind === "anthropic-compatible"
			? lazyApi(() => import("@earendil-works/pi-ai/api/anthropic-messages"))
			: lazyApi(() => import("@earendil-works/pi-ai/api/openai-completions")),
	});
};

export const modelSupportsImages = (providerId: string, modelId: string, configuration?: HarnessProviderConfiguration): boolean => {
	if (providerId === "fixture") return false;
	const kind = configuration?.kind ?? providerId as HarnessProviderKind;
	const provider = configuration?.kind.endsWith("-compatible")
		? customProvider(configuration, modelId)
		: builtinProvider(kind);
	return provider ? modelFromProvider(provider, kind, modelId, configuration?.modelMetadata)?.input.includes("image") ?? false : false;
};

export const defaultModelForProvider = (providerId: string): string | undefined => DEFAULT_MODELS[providerId];

const responseText = (message: AgentMessage | undefined): string => {
	if (!message || message.role !== "assistant") return "";
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
};

const emptyUsage = (): RunUsage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const REPAIR_PRIMARY_OUTPUT_RESERVE = 4_096;
const EVALUATION_MAX_MODEL_TURNS = 12;
const EVALUATION_MAX_TOOL_CALLS = 30;
const MAX_UNKNOWN_TOOL_CALLS = 2;
const MAX_REPAIR_ATTEMPTS = 2;
const MAX_CONVERSATION_BYTES = 192 * 1024;
const MAX_CONVERSATION_TURNS = 40;
const MAX_REASONING_CHARS = 64 * 1024;
const MAX_STREAM_TEXT_CHARS = 256 * 1024;
const WORKSPACE_INSPECTION_TOOLS = new Set(["list_workspace", "search_workspace", "inspect_workspace"]);
const DEFAULT_CONTEXT_TOKEN_BUDGET = 4_000;
const WORKSPACE_WRITE_TOOLS = new Set(["write_workspace", "edit_workspace"]);
const PACKAGE_COMMANDS = new Set(["npm", "pnpm", "yarn", "bun", "cargo", "go", "dotnet", "mvn", "gradle", "swift"]);
const DIRECT_SUBCOMMANDS = new Set(["test", "tests", "lint", "build", "check", "checks", "typecheck", "type-check", "verify"]);
const distinctDirectSubcommands = (actual: readonly string[], prohibited: readonly string[]): boolean => {
	const executable = (actual[0] ?? "").toLowerCase();
	if (actual[0] !== executable || prohibited[0]?.toLowerCase() !== executable || prohibited[0] !== prohibited[0]?.toLowerCase() || !PACKAGE_COMMANDS.has(executable)) return false;
	const subcommand = (argv: readonly string[]) => argv[1] === "run" ? argv[2] : argv[1];
	const actualSubcommand = subcommand(actual);
	const prohibitedSubcommand = subcommand(prohibited);
	return Boolean(actualSubcommand && prohibitedSubcommand && DIRECT_SUBCOMMANDS.has(actualSubcommand) && DIRECT_SUBCOMMANDS.has(prohibitedSubcommand) && actualSubcommand !== prohibitedSubcommand);
};
/** Time kept for a final answer: 20% of the run, at least 30s (or a quarter of a short run), at most 3 minutes. */
const finalizationReserveMs = (runMs: number): number => Math.min(180_000, Math.max(Math.min(30_000, runMs / 4), runMs / 5));
const DEEPSEEK_PREFIX_CONTINUATION_TEXT = "Continue the preceding response exactly where it stopped.";

const deepSeekPrefixFetch = (fetcher: typeof fetch): typeof fetch => async (input, init) => {
	if (typeof init?.body !== "string") throw new Error("DeepSeek prefix continuation requires a JSON request body");
	const body = JSON.parse(init.body) as { messages?: Array<Record<string, unknown>> };
	const messages = body.messages;
	if (!messages?.length || messages.at(-1)?.role !== "user" || !JSON.stringify(messages.at(-1)?.content).includes(DEEPSEEK_PREFIX_CONTINUATION_TEXT)) {
		throw new Error("DeepSeek prefix continuation request is missing its internal marker");
	}
	messages.pop();
	const prefix = messages.at(-1);
	if (!prefix || prefix.role !== "assistant") throw new Error("DeepSeek prefix continuation requires an assistant response prefix");
	prefix.prefix = true;
	const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
	url.pathname = "/beta/chat/completions";
	return fetcher(url, { ...init, body: JSON.stringify(body) });
};

const evaluationFeatures = (variant: HarnessEvaluationVariant | undefined) => ({
	tools: variant === undefined || variant === "MODEL_TOOLS" || variant === "MODEL_SKILLS_TOOLS" || variant === "MODEL_SKILLS_TOOLS_VERIFIERS" || variant === "FULL_PRESET",
	skills: variant === undefined || variant === "MODEL_SKILLS" || variant === "MODEL_SKILLS_TOOLS" || variant === "MODEL_SKILLS_TOOLS_VERIFIERS" || variant === "FULL_PRESET",
	verifierFeedback: variant === undefined || variant === "MODEL_SKILLS_TOOLS_VERIFIERS" || variant === "FULL_PRESET",
	moduleContext: variant === undefined || variant === "FULL_PRESET",
});

const evaluationSystemPrompt = (
	variant: HarnessEvaluationVariant | undefined,
	preset: import("@agent-harness/contracts").AgentPreset,
	tools: boolean,
	toolIds: string[] = preset.toolIds,
	canonicalToolIds: string[] = toolIds,
	modules: { moduleTools?: readonly HarnessModuleTool[]; toolInterface?: ToolInterface } = {},
): string => {
	if (!variant || (evaluationFeatures(variant).skills && tools)) return buildStableSystemPrompt(preset, toolIds, canonicalToolIds, modules);
	if (evaluationFeatures(variant).skills) return [
		"You are a model running in Codetonomy evaluation protocol v1.",
		`Apply preset ${preset.id}@${preset.version}: ${preset.purpose}.`,
		`Bundled skill identities: ${preset.coreSkillIds.join(", ") || "none"}.`,
		"Complete the task from the supplied prompt and context without external tools.",
		"Return the best final answer you can; independent deterministic checks will score it.",
	].join("\n");
	return [
		"You are a model running in Codetonomy evaluation protocol v1.",
		tools
			? "Use the provided tools when they are necessary to complete the task; do not claim unavailable tools are missing."
			: "Complete the task from the supplied prompt and context without external tools.",
		"Return the best final answer you can; independent deterministic checks will score it.",
	].join("\n");
};

const privateToolArgumentFields = (toolId: string): string[] =>
	toolId === "write_workspace" ? ["content"] : toolId === "edit_workspace" ? ["oldText", "newText"] : [];

const privateToolArgumentValues = (toolId: string, args: unknown): string[] =>
	args && typeof args === "object" && !Array.isArray(args)
		? privateToolArgumentFields(toolId).flatMap((field) => typeof (args as Record<string, unknown>)[field] === "string" ? [(args as Record<string, string>)[field]!] : [])
		: [];

const redactToolArgumentsForTrace = (toolId: string, args: unknown): unknown => {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;
	const fields = privateToolArgumentFields(toolId);
	if (!fields.length) return args;
	const safe = { ...(args as Record<string, unknown>) };
	for (const field of fields) if (typeof safe[field] === "string") {
		const value = safe[field];
		safe[field] = `[REDACTED ${Buffer.byteLength(value)} bytes sha256:${stableHash(value)}]`;
	}
	return safe;
};

export function projectConversation(
	turns: ConversationTurn[],
	maximumBytes = MAX_CONVERSATION_BYTES,
	maximumTurns = MAX_CONVERSATION_TURNS,
): ConversationProjection {
	if (!Number.isInteger(maximumBytes) || maximumBytes < 1 || !Number.isInteger(maximumTurns) || maximumTurns < 1) {
		throw new Error("Conversation projection limits must be positive integers");
	}
	const selected: ConversationTurn[] = [];
	let estimatedBytes = 2;
	for (let index = turns.length - 1; index >= 0 && selected.length < maximumTurns; index--) {
		const turn = turns[index]!;
		const bytes = Buffer.byteLength(JSON.stringify(turn)) + (selected.length ? 1 : 0);
		if (bytes + estimatedBytes > maximumBytes) break;
		selected.unshift(turn);
		estimatedBytes += bytes;
	}
	return {
		turns: selected,
		omittedTurns: turns.length - selected.length,
		estimatedBytes,
		projectionHash: stableHash(selected.map(({ runId, objective, output, prompt }) => ({ runId, objective, output, ...(prompt === undefined ? {} : { prompt }) }))),
	};
}

const addUsage = (total: RunUsage, message: AgentMessage): void => {
	if (message.role !== "assistant") return;
	total.reported = total.reported !== false && message.usage.totalTokens > 0 && !["error", "aborted"].includes(message.stopReason);
	total.input += message.usage.input;
	total.output += message.usage.output;
	total.cacheRead += message.usage.cacheRead;
	total.cacheWrite += message.usage.cacheWrite;
	total.totalTokens += message.usage.totalTokens;
	if (typeof message.usage.reasoning === "number") total.reasoning = (total.reasoning ?? 0) + message.usage.reasoning;
	if (total.cost) {
		total.cost.input += message.usage.cost.input;
		total.cost.output += message.usage.cost.output;
		total.cost.cacheRead += message.usage.cost.cacheRead;
		total.cost.cacheWrite += message.usage.cost.cacheWrite;
		total.cost.total += message.usage.cost.total;
	}
};

/** Adds usage a module tool reported (child runs), on success or failure, to the run's usage; malformed reports are ignored. */
const addReportedUsage = (total: RunUsage, value: unknown): void => {
	const extra = value as Partial<RunUsage> | undefined;
	const count = (item: unknown): item is number => typeof item === "number" && Number.isFinite(item) && item >= 0;
	if (!extra || typeof extra !== "object" || ![extra.input, extra.output, extra.cacheRead, extra.cacheWrite, extra.totalTokens].every(count)) return;
	if (extra.reported === false) total.reported = false;
	total.input += extra.input!;
	total.output += extra.output!;
	total.cacheRead += extra.cacheRead!;
	total.cacheWrite += extra.cacheWrite!;
	total.totalTokens += extra.totalTokens!;
	if (count(extra.reasoning)) total.reasoning = (total.reasoning ?? 0) + extra.reasoning;
	if (total.cost) {
		const cost = extra.cost;
		if (cost && [cost.input, cost.output, cost.cacheRead, cost.cacheWrite, cost.total].every(count)) {
			total.cost.input += cost.input;
			total.cost.output += cost.output;
			total.cost.cacheRead += cost.cacheRead;
			total.cost.cacheWrite += cost.cacheWrite;
			total.cost.total += cost.total;
		} else if (extra.totalTokens! > 0) total.reported = false;
	}
};

const outputDistribution = (message: AgentMessage): Record<string, unknown> => {
	if (message.role !== "assistant") return {};
	const reasoningTokens = message.usage.reasoning;
	return {
		outputTokens: message.usage.output,
		uncachedInputTokens: message.usage.input,
		cacheReadTokens: message.usage.cacheRead,
		cacheWriteTokens: message.usage.cacheWrite,
		...(typeof reasoningTokens === "number"
			? { reasoningTokens, visibleOutputTokens: Math.max(0, message.usage.output - reasoningTokens), reasoningReported: true }
			: { visibleOutputTokens: message.usage.output, reasoningReported: false }),
	};
};

function fixtureResponses(task: TaskSpecification, workspaceRoot: string, skillIds: string[]): FauxResponseStep[] {
	const skillSummary = skillIds.length ? `\nActivated skills: ${skillIds.join(", ")}` : "";
	if (!task.inputs.length) {
		if (task.requiredCapabilities.includes("workspace-inspection")) {
			return [
				fauxAssistantMessage(fauxToolCall("list_workspace", { path: ".", depth: 2, limit: 200 }), { stopReason: "toolUse" }),
				(context) => {
					const result = context.messages.findLast((message) => message.role === "toolResult");
					const text = result?.role === "toolResult"
						? result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
						: "";
					return fauxAssistantMessage(fauxText(`Inspected the workspace structure for: ${task.objective}${skillSummary}\n\n${text.slice(0, 4_000)}`));
				},
			];
		}
		return [
			fauxAssistantMessage(
				`Fixture agent completed: ${task.objective}${skillSummary}`,
			),
		];
	}

	const toolCalls = task.inputs.map((input) =>
		fauxToolCall("inspect_workspace", { path: relative(workspaceRoot, input.value) }),
	);
	return [
		fauxAssistantMessage(toolCalls, { stopReason: "toolUse" }),
		(context) => {
			const results = context.messages.filter((message) => message.role === "toolResult");
			const excerpts = task.inputs.map((input, index) => {
				const result = results[index];
				const text = result?.role === "toolResult"
					? result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
					: "";
				return `## ${basename(input.value)}\n\n${text.slice(0, 1200)}${text.length > 1200 ? "\n…" : ""}`;
			});
			return fauxAssistantMessage(
				fauxText(
					`Inspected ${task.inputs.length} file${task.inputs.length === 1 ? "" : "s"} for: ${task.objective}${skillSummary}\n\n${excerpts.join("\n\n")}`,
				),
			);
		},
	];
}

export function createHarness(): AgentHarness {
	return {
		async run(options) {
			if (options.signal?.aborted) throw new Error("Run aborted");
			const permissionMode = options.permissionMode ?? "ask";
			const toolInterface = resolveToolInterface(options);
			if (!isPermissionMode(permissionMode)) throw new Error("Invalid permissionMode");
			if (toolInterface !== "structured" && toolInterface !== "bash") throw new Error("Invalid toolInterface");
			validateRunOptions(options);
			const runModules = options.modules ?? [];
			const runModuleTools = listModuleTools(runModules);
			const moduleToolIds = runModuleTools.map(({ definition }) => definition.name);
			// Only approval-gated module tools may report workspace changes and usage made on the run's behalf.
			const reportingModuleToolIds = new Set(runModuleTools.filter(({ access }) => access === "approval").map(({ definition }) => definition.name));
			const workspaceInspectionTools = new Set([...WORKSPACE_INSPECTION_TOOLS, ...runModuleTools.filter(({ evidence }) => evidence === "inspection").map(({ definition }) => definition.name)]);
			const workspaceEvidenceToolIds = runModuleTools.filter(({ evidence }) => evidence !== undefined).map(({ definition }) => definition.name);
			// A resumed run adopts the saved spend projection when the caller does
			// not supply an explicit budget: held reservations stay held and any
			// ceiling from the interrupted run keeps applying conservatively.
			const spendBudget = options.spendBudgetState
				?? (options.recoveryState ? {
					...(options.recoveryState.spend.maxCostUsd !== undefined ? { maxCostUsd: options.recoveryState.spend.maxCostUsd } : {}),
					...(options.recoveryState.spend.maxTotalTokens !== undefined ? { maxTotalTokens: options.recoveryState.spend.maxTotalTokens } : {}),
					costUsd: options.recoveryState.spend.costUsd,
					totalTokens: options.recoveryState.spend.totalTokens,
					...(options.recoveryState.spend.reservedCostUsd !== undefined ? { reservedCostUsd: options.recoveryState.spend.reservedCostUsd } : {}),
					...(options.recoveryState.spend.reservedTokens !== undefined ? { reservedTokens: options.recoveryState.spend.reservedTokens } : {}),
				} : undefined)
				?? { maxCostUsd: options.maxCostUsd, maxTotalTokens: options.maxTotalTokens, costUsd: 0, totalTokens: 0 };
			if (!Number.isFinite(spendBudget.costUsd) || spendBudget.costUsd < 0 || !Number.isSafeInteger(spendBudget.totalTokens) || spendBudget.totalTokens < 0
				|| !Number.isFinite(spendBudget.reservedCostUsd ?? 0) || (spendBudget.reservedCostUsd ?? 0) < 0
				|| !Number.isSafeInteger(spendBudget.reservedTokens ?? 0) || (spendBudget.reservedTokens ?? 0) < 0
				|| (spendBudget.maxCostUsd !== undefined && (!Number.isFinite(spendBudget.maxCostUsd) || spendBudget.maxCostUsd <= 0))
				|| (spendBudget.maxTotalTokens !== undefined && (!Number.isSafeInteger(spendBudget.maxTotalTokens) || spendBudget.maxTotalTokens < 1))
				|| (options.maxCostUsd !== undefined && spendBudget.maxCostUsd !== options.maxCostUsd)
				|| (options.maxTotalTokens !== undefined && spendBudget.maxTotalTokens !== options.maxTotalTokens)) throw new Error("Invalid aggregate spend budget state");
			const budgetLimitMessage = (): string | undefined => {
				if (spendBudget.maxCostUsd !== undefined && spendBudget.costUsd >= spendBudget.maxCostUsd) return `Aggregate cost ceiling reached ($${spendBudget.maxCostUsd})`;
				if (spendBudget.maxTotalTokens !== undefined && spendBudget.totalTokens >= spendBudget.maxTotalTokens) return `Aggregate token ceiling reached (${spendBudget.maxTotalTokens})`;
				return undefined;
			};
			if ((spendBudget.costUsd > 0 || spendBudget.totalTokens > 0) && budgetLimitMessage()) throw new Error(budgetLimitMessage());
			const maxModelTurns = options.maxModelTurns ?? (options.evaluationVariant ? EVALUATION_MAX_MODEL_TURNS : 100);
			const maxToolCalls = options.maxToolCalls ?? (options.evaluationVariant ? EVALUATION_MAX_TOOL_CALLS : 500);
			const runBudget = options.runBudgetState ?? { deadline: Date.now() + (options.maxDurationMs ?? 1_800_000), modelTurns: 0, toolCalls: 0 };
			if (!Number.isFinite(runBudget.deadline) || !Number.isSafeInteger(runBudget.modelTurns) || !Number.isSafeInteger(runBudget.toolCalls) || runBudget.modelTurns < 0 || runBudget.toolCalls < 0) throw new Error("Invalid run budget state");
			const images = options.images ?? [];
			const runStartedAt = performance.now();
			const runStartedWallClock = Date.now();
			const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
			const canonicalWorkspaceRoot = await realpath(workspaceRoot).catch(() => workspaceRoot);
			const providerId = options.provider ?? "fixture";
			const modelId = options.modelId ?? defaultModelForProvider(providerId);
			const cacheSessionId = options.sessionId ?? stableHash({ workspace: canonicalWorkspaceRoot, providerId, modelId });
			if (!modelId || !/^[A-Za-z0-9~][A-Za-z0-9._:/~-]{0,191}$/.test(modelId)) {
				throw new Error(`A valid model id is required for ${providerId}`);
			}
			if (options.providerConfiguration && options.providerConfiguration.id !== providerId) {
				throw new Error("Provider configuration does not match the selected provider");
			}
			const canonicalConversation = options.conversation ?? [];
			if (canonicalConversation.length >= MAX_SESSION_TURNS) throw new Error("Conversation history reached the session turn limit; start a new session");
			if (Buffer.byteLength(JSON.stringify(canonicalConversation)) > MAX_SESSION_BYTES) throw new Error("Conversation history exceeds 16 MiB; start a new session");
			if (options.transcript) validateConversationTranscript(options.transcript);
			for (const turn of canonicalConversation) {
				if (turn.prompt !== undefined && (typeof turn.prompt !== "string" || !turn.prompt.trim() || Buffer.byteLength(turn.prompt) > MAX_CONVERSATION_PROMPT_BYTES)) throw new Error("Invalid conversation prompt");
				if (!turn.runId || !turn.objective.trim() || !turn.output.trim() || !Number.isFinite(turn.timestamp)) {
					throw new Error("Conversation history contains an invalid turn");
				}
			}
			const conversationProjection = projectConversation(canonicalConversation);
			const conversation = conversationProjection.turns;
			const features = evaluationFeatures(options.evaluationVariant);
			const providerCacheCapabilities = options.providerConfiguration?.modelMetadata?.cacheStrategy
				? { strategies: [options.providerConfiguration.modelMetadata.cacheStrategy], supportsUsageReporting: false }
				: cacheCapabilitiesForProvider(options.providerConfiguration?.kind ?? (providerId as HarnessProviderKind | "fixture"));
			const cacheRetention = options.cacheRetention ?? options.providerConfiguration?.modelMetadata?.cacheRetention
				?? (providerCacheCapabilities.strategies.includes("NO_PROVIDER_CACHE") ? "none" : "short");
			if (!["none", "short", "long"].includes(cacheRetention)) throw new Error("Invalid cache retention");
			const contextRetentionTokens = options.contextRetentionTokens ?? options.providerConfiguration?.modelMetadata?.contextRetentionTokens ?? 262_144;
			if (!Number.isSafeInteger(contextRetentionTokens) || contextRetentionTokens < 4096) throw new Error("Context retention must be at least 4096 tokens");
			const activatedSkills = [...new Map((options.activatedSkills ?? []).map((skill) => [skill.id, skill])).values()];
			if (activatedSkills.length > 8) throw new Error("A run can activate at most 8 skills");
			let skillBytes = 0;
			for (const skill of activatedSkills) {
				if (!/^[A-Za-z][A-Za-z0-9:_-]{0,63}$/.test(skill.id)) throw new Error(`Invalid skill id: ${skill.id}`);
				if (skill.manifest) {
					if (skill.manifest.id !== skill.id) throw new Error(`Skill manifest id does not match ${skill.id}`);
					for (const entries of [
						skill.manifest.dependencies,
						skill.manifest.conflicts,
						skill.manifest.requiredCapabilities,
						skill.manifest.requiredTools,
						skill.manifest.requiredPermissions,
						skill.manifest.verifierIds,
					]) {
						if (!Array.isArray(entries) || entries.length > 32 || entries.some((entry) => typeof entry !== "string")) {
							throw new Error(`Invalid manifest for skill ${skill.id}`);
						}
					}
				}
				skillBytes += Buffer.byteLength(skill.instructions);
			}
			if (skillBytes > 128 * 1024) throw new Error("Activated skill instructions exceed 131072 bytes");
			const runId = randomUUID();
			const runDirectory = join(resolve(options.traceDirectory ?? ".harness/runs"), runId);
			const tracePath = join(runDirectory, "trace.jsonl");
			const knownSecrets = runtimeKnownSecrets(options.providerConfiguration);
			const trace = new RunTrace(runId, tracePath, options.observers, knownSecrets);
			const checkpoint = new RunCheckpoint(workspaceRoot, runId, join(runDirectory, "checkpoint.json"));
			const outputStore = new CommandOutputStore({
				runId,
				workspaceRoot,
				sessionId: options.sessionId,
				previousOutputs: options.transcript?.outputRuns,
				indexPath: join(runDirectory, TOOL_OUTPUT_MANIFEST),
				knownSecrets,
			});
			let task: TaskSpecification | undefined;
			let runCapabilities: RunResult["capabilities"] | undefined;
			let completedRun: RunResult | undefined;
			let runEventId: string | undefined;
			const issuedOutputIds = new Set<string>();
			const deadlineController = new AbortController();
			const deadlineTimer = setTimeout(() => deadlineController.abort(new Error("Run deadline exceeded")), Math.max(0, runBudget.deadline - Date.now()));
			let releaseUnusedRepairReservations = (): void => {};
			options = { ...options, signal: AbortSignal.any([deadlineController.signal, ...(options.signal ? [options.signal] : [])]) };
			// Declared outside the try so the exception path can publish a resumable
			// checkpoint and retain known usage instead of discarding both.
			let usage = emptyUsage();
			let pricingKnown = false;
			let lastPreparedMessages: Message[] | undefined;
			let agent!: Agent;
			const recoverableToolErrors = new Map<string, RecoverableToolError>();
			// Seeded uncertainty from the previous run. modelTurn 0 means trusted
			// reconciliation evidence must come from this run: fresh reads and
			// inspections qualify, stale prior-run evidence never does.
			for (const [index, mutation] of (options.recoveryState?.uncertainMutations ?? []).entries()) {
				recoverableToolErrors.set(`recovered-${index}`, recoverableErrorFromMutation(mutation));
			}
			let recoveryUsageUnknown = options.recoveryState?.spend.usageUnknown === true;
			const publishSessionCheckpoint = async (): Promise<void> => {
				if (!options.onTranscript) return;
				try {
					if (!lastPreparedMessages && !agent) return;
					const currentMessages = agent ? await agent.convertToLlm(agent.state.messages) : [];
					const messages = resumableCheckpointMessages(lastPreparedMessages, currentMessages);
					if (!messages) return;
					let reference;
					try { reference = outputStore.sessionReference(); } catch { reference = undefined; }
					const outputRuns = [...(options.transcript?.outputRuns ?? []), ...(reference ? [reference] : [])];
					const toolSet = runCapabilities ? {
						presetId: runCapabilities.preset.id,
						permissionProfileId: runCapabilities.permissionProfileId,
						toolInterface,
						toolIds: runCapabilities.toolIds,
						...(runCapabilities.canonicalToolIds ? { canonicalToolIds: runCapabilities.canonicalToolIds } : {}),
					} : options.transcript?.toolSet;
					options.onTranscript?.({ version: 1, messages, ...(outputRuns.length ? { outputRuns } : {}), ...(toolSet ? { toolSet } : {}) });
				} catch {
					// A checkpoint publication failure must never replace the run's own outcome.
				}
			};
			// Run-local recovery state must survive save/reload: unresolved
			// unknown-effects mutations keep gating resumed writes, and held spend
			// reservations plus unknown usage flags carry across sessions.
			const buildRecoveryState = (): RunRecoveryState => ({
				version: 1,
				uncertainMutations: [...recoverableToolErrors.values()]
					.filter((failure) => !failure.resolved && failure.outcome === "effects-unknown")
					.map(mutationFromRecoverableError),
				spend: {
					...(spendBudget.maxCostUsd !== undefined ? { maxCostUsd: spendBudget.maxCostUsd } : {}),
					...(spendBudget.maxTotalTokens !== undefined ? { maxTotalTokens: spendBudget.maxTotalTokens } : {}),
					costUsd: spendBudget.costUsd,
					totalTokens: spendBudget.totalTokens,
					...((spendBudget.reservedCostUsd ?? 0) > 0 ? { reservedCostUsd: spendBudget.reservedCostUsd! } : {}),
					...((spendBudget.reservedTokens ?? 0) > 0 ? { reservedTokens: spendBudget.reservedTokens! } : {}),
					// Unknown evidence: a restored flag, unreported known usage, or a
					// reservation still held after unused repair capacity was released —
					// an admitted provider request never settled, so its wire usage is
					// unknown even when this run reported zero tokens. Admission
					// rejections release their reservation (or never hold one), so a
					// known never-sent request with zero totals stays known.
					...(recoveryUsageUnknown
						|| (usage.totalTokens > 0 && usage.reported !== true)
						|| (spendBudget.reservedCostUsd ?? 0) > 0
						|| (spendBudget.reservedTokens ?? 0) > 0
						? { usageUnknown: true } : {}),
				},
			});

			try {
				const runEvent = await trace.emit("run.started", { repairSchemaVersion: options.repairWorker ? 2 : 1, workspaceRoot, permissionMode, toolInterface, modules: (options.modules ?? []).map(({ id }) => id), ...(options.repairWorker ? { repairWorker: options.repairWorker } : {}) });
				runEventId = runEvent.eventId;
				const compiledTask = options.application?.compileTask ? options.application.compileTask(options) : compileTask(options);
				task = compiledTask;
				const taskEvent = await trace.emit("task.compiled", { task: compiledTask }, runEventId);
				const selectedSkills = features.skills ? activatedSkills : [];
				let capabilities = resolveCapabilities(compiledTask, {
					providerId,
					modelId,
				}, selectedSkills.map(({ id }) => id), selectedSkills.flatMap(({ manifest }) => manifest ? [manifest] : []), {
					...(options.presetId ? { presetId: options.presetId } : {}),
					// Write-scoped children keep read-only module tools; they never run commands.
					...(options.writePaths?.length ? { toolCeiling: [...CODING_TOOL_IDS.filter((id) => id !== "run_workspace_command"), ...moduleToolIds] } : {}),
					delegationDepth: options.delegationDepth ?? 0,
					toolInterface,
					moduleTools: runModuleTools,
					toolSelection: options.toolSelection,
					...(options.transcript?.toolSet ? { sessionTools: options.transcript.toolSet } : {}),
					...(options.application?.toolIds ? { toolCeiling: options.application.toolIds.filter((id) => !options.writePaths?.length || moduleToolIds.includes(id) || (CODING_TOOL_IDS.includes(id as typeof CODING_TOOL_IDS[number]) && id !== "run_workspace_command")) } : {}),
				});
				capabilities = { ...capabilities, preset: { ...capabilities.preset, cacheStrategy: providerCacheCapabilities.strategies[0]! } };
				const skillFingerprints = selectedSkills.map(({ id, instructions }) => ({ id, contentHash: stableHash(instructions) }));
				const conversationFingerprints = conversation.map(({ runId, objective, output }) => ({ runId, contentHash: stableHash({ objective, output }) }));
				const dependencyFingerprints = [...(options.verifiedDependencies ?? new Map()).entries()].map(([id, run]) => ({ id, runId: run.runId, verified: run.verification.passed, contentHash: stableHash({ output: run.output, artifacts: run.artifacts }) }));
				if (dependencyFingerprints.some(({ verified }) => !verified)) throw new Error("Only verified dependency results may enter a child context");
				// Module context goes only into the user message; the core owns its budget and label.
				const recallModule = features.moduleContext ? runModules.find(({ recall }) => recall) : undefined;
				const contextTokenBudget = options.contextTokenBudget ?? DEFAULT_CONTEXT_TOKEN_BUDGET;
				const recallEnabled = Boolean(recallModule && contextTokenBudget > 0);
				const recallEvent = recallEnabled
					? await trace.emit("module.recall.started", { moduleId: recallModule!.id, tokenBudget: contextTokenBudget }, taskEvent.eventId)
					: undefined;
				let contextPacket;
				try {
					contextPacket = await compileContext({
						taskId: compiledTask.id,
						agentPresetId: capabilities.preset.id,
						query: compiledTask.objective,
						tokenBudget: recallEnabled ? contextTokenBudget : 0,
						...(recallEnabled ? { recall: (query: string, tokenBudget: number, signal?: AbortSignal) => recallModule!.recall!({ query, tokenBudget, ...(signal ? { signal } : {}) }) } : {}),
						signal: options.signal,
					});
					if (recallEvent) await trace.emit("module.recall.completed", {
						moduleId: recallModule!.id,
						contextHash: contextPacket.contextHash,
						estimatedTokens: contextPacket.estimatedTokens,
						evidenceItems: contextPacket.evidence.length,
					}, recallEvent.eventId);
				} catch (error) {
					if (recallEvent) await trace.emit("module.recall.failed", { moduleId: recallModule!.id, message: error instanceof Error ? error.message : String(error) }, recallEvent.eventId);
					throw error;
				}
				capabilities = {
					...capabilities,
					toolIds: features.tools ? capabilities.toolIds : [],
					...(capabilities.canonicalToolIds ? { canonicalToolIds: features.tools ? capabilities.canonicalToolIds : [] } : {}),
					skillIds: features.skills ? capabilities.skillIds : [],
					permissionProfileId: features.tools ? capabilities.permissionProfileId : "workspace-read",
					skillPackHash: stableHash({ skillPackHash: capabilities.skillPackHash, activatedSkills: skillFingerprints }),
					contextPacketHash: stableHash({
						task: capabilities.contextPacketHash,
						activatedSkills: skillFingerprints,
						conversationProjection: conversationProjection.projectionHash,
						retrievedContext: contextPacket.contextHash,
						verifiedDependencies: dependencyFingerprints,
					}),
					runProfileHash: stableHash({
						runProfileHash: capabilities.runProfileHash,
						evaluationVariant: options.evaluationVariant ?? "FULL_PRESET",
						permissionMode,
						activatedSkills: skillFingerprints,
						conversation: conversationFingerprints,
						verifiedDependencies: dependencyFingerprints,
					}),
				};
				const availableCanonicalToolIds = new Set((capabilities.canonicalToolIds ?? capabilities.toolIds).filter((id) => !capabilities.carriedToolIds?.includes(id)));
				const writeClaim = await normalizeWriteClaim(
					workspaceRoot,
					capabilities.permissionProfileId === "workspace-read" ? "workspace-read" : "workspace-write",
					features.tools ? options.writePaths : undefined,
				);
				if (options.evaluationVariant) capabilities = {
					...capabilities,
					toolBundleHash: buildToolBundleHash(capabilities.toolIds, capabilities.canonicalToolIds ?? capabilities.toolIds, runModuleTools),
					cachePrefixHash: stableHash({
						providerId,
						modelId,
						systemPrompt: evaluationSystemPrompt(options.evaluationVariant, capabilities.preset, features.tools, capabilities.toolIds, capabilities.canonicalToolIds ?? capabilities.toolIds, { moduleTools: runModuleTools, toolInterface }),
						permissionProfileId: capabilities.permissionProfileId,
						toolIds: capabilities.toolIds,
					}),
				};
				runCapabilities = capabilities;
				const providerAffinityEnabled = Boolean(options.cacheAffinityId) && !providerCacheCapabilities.strategies.includes("NO_PROVIDER_CACHE");
				const providerSessionId = providerAffinityEnabled
					? deriveCacheAffinityId({
						scopeId: options.cacheAffinityId!,
						providerId,
						modelId,
						cachePrefixHash: capabilities.cachePrefixHash,
						toolBundleHash: capabilities.toolBundleHash,
						permissionProfileId: capabilities.permissionProfileId,
					})
					: cacheSessionId;
				const capabilityEvent = await trace.emit("capabilities.resolved", {
					capabilities,
					evaluationVariant: options.evaluationVariant ?? "FULL_PRESET",
					skillVersions: capabilities.skillIds.map((id) => {
						const skill = selectedSkills.find((candidate) => candidate.id === id);
						return { id, version: skill?.manifest?.version ?? "preset-bundled", ...(skill ? { contentHash: stableHash(skill.instructions) } : {}) };
					}),
					toolVersions: resolveToolCacheDefinitions(capabilities.toolIds, runModuleTools).map((definition) => {
						const item = definition as { name?: string; version?: string };
						return { id: item.name, version: item.version };
					}),
					providerCacheCapabilities,
				}, taskEvent.eventId);
				const cacheShape = captureCacheShape(providerId, modelId, capabilities, { cacheAffinityId: providerAffinityEnabled ? providerSessionId : undefined });
				const cacheLookup = await lookupAndStoreCacheShape(
					resolve(options.traceDirectory ?? ".harness/runs"),
					providerAffinityEnabled ? providerSessionId : options.sessionId,
					cacheShape,
				);
				await trace.emit("cache.lookup", {
					scope: "prefix-configuration",
					strategy: capabilities.preset.cacheStrategy,
					cachePrefixHash: capabilities.cachePrefixHash,
					toolBundleHash: capabilities.toolBundleHash,
					skillPackHash: capabilities.skillPackHash,
					permissionProfileId: capabilities.permissionProfileId,
					...(cacheShape.cacheAffinityIdHash ? { cacheAffinityIdHash: cacheShape.cacheAffinityIdHash } : {}),
					status: cacheLookup.status,
				}, capabilityEvent.eventId);
				if (cacheLookup.status === "invalidated") {
					await trace.emit("cache.invalidated", { changed: cacheLookup.changed }, capabilityEvent.eventId);
				}
				await trace.emit("context.compiled", {
					inputCount: compiledTask.inputs.length,
					activatedSkills: skillFingerprints,
					conversationTurns: conversation.length,
					omittedConversationTurns: conversationProjection.omittedTurns,
					conversationProjectionHash: conversationProjection.projectionHash,
					verifiedDependencies: dependencyFingerprints,
					retrievedEvidenceItems: contextPacket.evidence.length,
					retrievedContextTokens: contextPacket.estimatedTokens,
					stablePrefixTokens: Math.ceil(Buffer.byteLength(evaluationSystemPrompt(options.evaluationVariant, capabilities.preset, features.tools, capabilities.toolIds, capabilities.canonicalToolIds ?? capabilities.toolIds, { moduleTools: runModuleTools, toolInterface })) / 4),
					loadedSkillTokens: Math.ceil(skillBytes / 4),
					contextPacketHash: capabilities.contextPacketHash,
					stablePrefixHash: capabilities.cachePrefixHash,
				}, capabilityEvent.eventId);

				const models = createModels();
				let model;
				if (providerId === "fixture") {
					const faux = fauxProvider({ provider: providerId, tokensPerSecond: 500 });
					models.setProvider(faux.provider);
					faux.setResponses(fixtureResponses(compiledTask, workspaceRoot, selectedSkills.map(({ id }) => id)));
					model = faux.getModel(modelId);
				} else {
					const configured = options.providerConfiguration;
					const provider = configured?.kind.endsWith("-compatible")
						? customProvider(configured, modelId)
						: builtinProvider(configured?.kind ?? providerId);
					if (!provider) throw new Error(`Unknown provider: ${providerId}`);
					if (configured) validateProviderConfiguration(configured);
					models.setProvider(provider);
					model = modelFromProvider(provider, configured?.kind ?? providerId as HarnessProviderKind, modelId, configured?.modelMetadata);
				}
				if (!model) throw new Error(`Unknown ${providerId} model: ${modelId}`);
				if (options.providerFetch && FETCHLESS_APIS.has(model.api)) throw new Error(`providerFetch is not supported for ${model.api} models`);
				const modelProfile = resolveModelProfile({ provider: options.providerConfiguration?.kind ?? providerId, modelId });
				const effectiveReasoning = effectiveReasoningLevel(options.reasoningLevel, modelProfile);
				const reasoningLevel = effectiveReasoning.level;
				const actionNudge = effectiveActionNudgeMode(options.actionNudgeMode, modelProfile);
				await trace.emit("model.profile.resolved", { profileId: modelProfile.id, profileHash: modelProfile.hash, matched: modelProfile.matched, reasoningLevel, reasoningLevelSource: effectiveReasoning.source,
					actionNudgeMode: actionNudge.mode, actionNudgeModeSource: actionNudge.source,
					// "on-off" models (for example Kimi K2.6, GLM 5.3) ignore effort levels; only thinking on/off applies.
					reasoningControl: !model.reasoning ? "none" : (model.compat as { supportsReasoningEffort?: boolean } | undefined)?.supportsReasoningEffort === false ? "on-off" : "levels" }, capabilityEvent.eventId);
				const historicalReasoningBilled = modelProfile.protocol.historicalReasoningBilled ?? true;
				if (modelProfile.protocol.reasoningRequired && reasoningLevel === "off") throw new Error(`${modelProfile.label ?? `${providerId}/${modelId}`} requires reasoning; select low, high, or xhigh instead of off`);
				pricingKnown = !options.providerConfiguration?.kind.endsWith("-compatible") || Boolean(options.providerConfiguration.modelMetadata);
				if (spendBudget.maxCostUsd !== undefined && !pricingKnown) throw new Error("A dollar budget requires explicit model pricing for custom endpoints");
				if (images.length && !model.input.includes("image")) throw new Error(`Model ${providerId}/${modelId} does not support image input`);
				const explicitMaxOutputTokens = options.maxOutputTokens;
				const sessionOutputTokenBudget = options.maxTotalTokens ?? Infinity;
				// Module tools that start child runs (orchestration) receive the options every child must
				// inherit; the budgets are the live shared objects, so children spend from this run's limits.
				const moduleRun: HarnessModuleRunContext = {
					depth: options.delegationDepth ?? 0,
					permissionProfileId: capabilities.permissionProfileId,
					inheritedOptions: {
						workspaceRoot,
						traceDirectory: options.traceDirectory,
						provider: providerId,
						modelId,
						toolSelection: options.toolSelection,
						providerConfiguration: options.providerConfiguration,
						permissionMode,
						delegationDepth: options.delegationDepth ?? 0,
						activatedSkills: options.activatedSkills,
						observers: options.observers,
						approve: options.approve,
						providerFetch: options.providerFetch,
						cacheAffinityId: options.cacheAffinityId,
						cacheRetention: options.cacheRetention,
						contextRetentionTokens: options.contextRetentionTokens,
						actionNudgeMode: options.actionNudgeMode,
						toolInterface: options.toolInterface,
						...(options.modules ? { modules: options.modules } : {}),
						contextTokenBudget: options.contextTokenBudget,
						runStore: options.runStore,
						evaluationVariant: options.evaluationVariant,
						maxOutputTokens: options.maxOutputTokens,
						maxModelTurns,
						maxToolCalls,
						maxDurationMs: options.maxDurationMs,
						runBudgetState: runBudget,
						providerRetryLimit: options.providerRetryLimit,
						providerMaxRetryDelayMs: options.providerMaxRetryDelayMs,
						maxCostUsd: options.maxCostUsd,
						maxTotalTokens: options.maxTotalTokens,
						spendBudgetState: spendBudget,
						reasoningLevel: options.reasoningLevel,
						repairWorker: options.repairWorker,
						onStream: options.onStream,
						onProviderResponse: options.onProviderResponse,
					} satisfies Partial<HarnessRunOptions>,
				};
				const bashReadOnlyFallback = capabilities.permissionProfileId === "workspace-read" && !options.application?.toolIds && !options.writePaths && permissionMode !== "full-access";
				const bashPlanner = new BashCommandPlanner(workspaceRoot);
				const tools = resolveTools(capabilities.toolIds, workspaceRoot, {
					before: (path) => checkpoint.before(path),
					after: (path) => checkpoint.after(path),
					beforeWorkspace: () => checkpoint.beforeWorkspace(),
					afterWorkspace: () => checkpoint.afterWorkspace(),
					coverage: () => checkpoint.coverage(),
					workspaceCaptureComplete: () => checkpoint.workspaceCaptureComplete(),
				}, writeClaim, {
					moduleTools: runModuleTools,
					moduleRun,
					onModuleToolFailureUsage: (reported) => addReportedUsage(usage, reported),
					commandSandboxMode: permissionMode === "full-access" ? "full-access" : "workspace",
					bashCommandSandboxMode: permissionMode === "full-access"
						? "full-access"
						: capabilities.permissionProfileId === "workspace-read" ? "read-only" : "workspace",
					bashNativeOperationId: "inspect_workspace",
					bashReadOnlyFallback,
					bashAllowedCanonicalToolIds: capabilities.canonicalToolIds?.filter((id) => !capabilities.carriedToolIds?.includes(id)),
					bashPlanner,
					outputStore,
					privatePaths: [runDirectory, ...outputStore.privatePaths()],
				});
				const truncationDiscoveryNudgeText = capabilities.toolIds.includes("bash")
					? "The next response must call bash to inspect the workspace immediately. Do not return prose or another plan; use the result to continue the task."
					: TRUNCATION_DISCOVERY_NUDGE_TEXT;
				const activeTools = tools.map((tool) => ({ ...tool, execute: async (...args: Parameters<typeof tool.execute>) => {
					options.signal?.throwIfAborted();
					dispatched.add(args[0]);
					try { return await tool.execute(...args); }
					catch (error) {
						const details = (error as { details?: Record<string, unknown> }).details ?? {};
						const operation = canonicalToolIds.get(args[0]) ?? tool.name;
						const mutationRisk = details.mutationRisk === "none" || details.mutationRisk === "possible"
							? details.mutationRisk
							: details.executionOutcome === "rejected-before-start" ? "none"
								: WORKSPACE_WRITE_TOOLS.has(operation) || operation === "run_workspace_command" ? "possible" : "none";
						executionErrors.set(args[0], {
							...details,
							code: (error as NodeJS.ErrnoException).code,
							resultKind: details.resultKind ?? "failure",
							mutationRisk,
							executionOutcome: details.executionOutcome ?? (mutationRisk === "possible" ? "effects-unknown" : "known"),
						});
						throw error;
					}
				} }));
				const approve = permissionMode === "ask" ? options.approve : async () => true;
				const gate = new PermissionGate(getPermissionProfile(capabilities.permissionProfileId), approve, runModuleTools.map(({ definition, access }) => [definition.name, access] as const));
				const requestApiKey = options.providerConfiguration?.apiKey
					?? (options.providerConfiguration?.kind.endsWith("-compatible") ? "codetonomy-keyless" : undefined);
				let currentModelRequestId: string | undefined;
				type WireRequestRole = "primary" | "repair-worker";
				type WireRequestRecord = { observation: WireRequestObservation; previous?: WireRequestObservation; commonPrefixBytes: number };
				const lastWireRequests = new Map<WireRequestRole, { payload: string; observation: WireRequestObservation }>();
				const wireRequests = new Map<string, WireRequestRecord>();
				const wireRequestData = (requestId: string | undefined, providerCacheRead?: number): Record<string, unknown> => {
					if (!requestId) return {};
					const record = wireRequests.get(requestId);
					if (!record) return {};
					return {
						...record.observation,
						commonPrefixBytes: record.commonPrefixBytes,
						commonPrefixEstimatedTokens: Math.ceil(record.commonPrefixBytes / 4),
						...(providerCacheRead === undefined ? {} : { cacheMissReason: classifyCacheMiss(record.previous, record.observation, providerCacheRead) }),
					};
				};
				const observeProviderRequest = async (payload: unknown, requestRole: WireRequestRole, requestId: string | undefined): Promise<void> => {
					if (typeof payload !== "string") {
						await trace.emit("context.prepared", { stage: "wire-observed", requestRole, wireParseable: false }, requestId).catch(() => undefined);
						return;
					}
					let observation: WireRequestObservation;
					try {
						observation = observeWireRequest(payload, {
							providerId,
							modelId,
							...(providerAffinityEnabled ? { affinityId: providerSessionId } : {}),
							...(options.sessionId ? { localSessionId: options.sessionId } : {}),
						});
					} catch {
						const wireBytes = Buffer.byteLength(payload, "utf8");
						await trace.emit("context.prepared", {
							stage: "wire-observed",
							requestRole,
							wireParseable: false,
							wireRequestHash: createHash("sha256").update(payload, "utf8").digest("hex"),
							wireBytes,
							wireEstimatedTokens: Math.ceil(wireBytes / 4),
						}, requestId).catch(() => undefined);
						return;
					}
					const previous = lastWireRequests.get(requestRole);
					const record: WireRequestRecord = {
						observation,
						...(previous ? { previous: previous.observation, commonPrefixBytes: commonPrefixBytes(previous.payload, payload) } : { commonPrefixBytes: 0 }),
					};
					lastWireRequests.set(requestRole, { payload, observation });
					if (requestId) wireRequests.set(requestId, record);
					await trace.emit("context.prepared", { stage: "wire-observed", requestRole, ...wireRequestData(requestId) }, requestId).catch(() => undefined);
				};
				let currentModelStartedAt = 0;
				let firstTokenSeen = false;
				let fatalRuntimeError: string | undefined;
				let modelOutputFailure: string | undefined;
				let turnBudgetExhausted = false;
				const preciseCommands = new Map<string, string[]>();
				const requiredValidationCommands = compiledTask.acceptanceCriteria.flatMap(c => c.required && c.command && PACKAGE_COMMANDS.has(c.command[0]!.split(/[\\/]/).at(-1)!) && DIRECT_SUBCOMMANDS.has(c.command[1] === "run" ? c.command[2]! : c.command[1]!) ? [c.command] : []);
				const commandRecovery = (callId: string, details?: Record<string, unknown>) => {
					if (permissionMode === "full-access" || details?.sandbox !== "codetonomy-native") return undefined;
					const failedCommand = preciseCommands.get(callId);
					const failedRequired = failedCommand && requiredValidationCommands.find(command => commandMatches(failedCommand, command));
					const retryCommand = failedRequired ?? requiredValidationCommands[0];
					const optionalDiagnostic = !compiledTask.acceptanceCriteria.some(c => c.command && failedCommand && commandMatches(failedCommand, c.command));
					return retryCommand && (failedRequired || optionalDiagnostic)
						? { retryCommand, optionalDiagnostic, retryCwd: failedRequired ? resolve(workspaceRoot, String(details.cwd ?? ".")) : workspaceRoot }
						: undefined;
				};
				const approvedCorrections = new Map<string, Set<string>>();
				const failureCounts = new Map<string, number>();
				const operationKeys = new Map<string, string>();
				const recoveryKeys = new Map<string, string>();
				const dispatched = new Set<string>();
				const blockedToolCalls = new Set<string>();
				const executionErrors = new Map<string, Record<string, unknown>>();
				const finalizedToolCalls = new Map<string, { arguments: unknown; parseStatus?: string; truncated: boolean; ordinal: number }>();
				let toolCallOrdinal = 0;
				const repairQueue: Array<{ candidate: RepairFailureCandidate; failureEventId: string; ordinal: number }> = [];
				const repairReceipts = new Map<string, RepairReceipt>();
				const proposalOrigins = new Map<string, string>();
				const attemptedRepairFingerprints = new Set<string>();
				let repairWorkerGenerations = 0;
				let pendingWorkerSpendReservation: Reservation | undefined;
				let pendingPrimarySpendReservation: Reservation | undefined;
				let pendingPrimaryModelTurn = false;
				let pendingPrimaryToolCall = false;
				let unreconciledWorkerOutputTokens = 0;
				const fileEvidence: Array<{ target: string; action: "read" | "write" | "exists" | "delete"; callId: string; current: boolean; revision?: string; modelTurn: number }> = [];
				const targetPath = (args: unknown): string | undefined => {
					const value = args as { path?: unknown; outputPath?: unknown } | undefined;
					const path = value?.path ?? value?.outputPath;
					return typeof path === "string" ? resolve(workspaceRoot, path.replace(/^\/workspace(?:\/|$)/, "")) : undefined;
				};
				const isInside = (root: string, target: string): boolean => {
					const local = relative(root, target);
					return local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
				};
				const isWorkspaceTarget = (target: string): boolean => isInside(workspaceRoot, target);
				const fileIdentity = (info: Awaited<ReturnType<typeof lstat>>) => ({ size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs, ino: info.ino, mode: info.mode });
				const revisionOf = async (target?: string): Promise<string> => {
					if (!target || !isWorkspaceTarget(target)) return "unknown";
					const lexicalRelative = relative(workspaceRoot, target);
					if (isSensitiveWorkspacePath(lexicalRelative)) return "protected";
					try {
						const [link, sourcePath] = await Promise.all([lstat(target), realpath(target)]);
						const sourceRelative = relative(canonicalWorkspaceRoot, sourcePath);
						if (!isInside(canonicalWorkspaceRoot, sourcePath) || isSensitiveWorkspacePath(sourceRelative)) return "protected";
						const source = await lstat(sourcePath);
						if (!source.isFile()) return stableHash({ link: fileIdentity(link), sourcePath: sourceRelative || ".", source: fileIdentity(source) });
						const { hash } = await readRuntimeSource(sourcePath, options.signal);
						if (stableHash(fileIdentity(source)) !== stableHash(fileIdentity(await lstat(sourcePath)))) return "unknown";
						// Metadata-only ctime changes do not stale content evidence; content changes still do.
						const { ctime: _linkCtime, ...linkIdentity } = fileIdentity(link);
						const { ctime: _sourceCtime, ...sourceIdentity } = fileIdentity(source);
						return stableHash({ link: linkIdentity, sourcePath: sourceRelative || ".", source: sourceIdentity, hash });
					}
					catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown"; }
				};
				let workspaceRevision = 0;
				const sourceRevisionFor = async (target?: string, revision?: string): Promise<string> => stableHash({ workspaceRevision, target: revision ?? await revisionOf(target) });
				const releasePendingPrimaryCapacity = (): void => {
					if (pendingPrimarySpendReservation) releaseReservation(spendBudget, pendingPrimarySpendReservation);
					pendingPrimarySpendReservation = undefined;
					if (pendingPrimaryModelTurn) runBudget.modelTurns--;
					if (pendingPrimaryToolCall) runBudget.toolCalls--;
					pendingPrimaryModelTurn = false;
					pendingPrimaryToolCall = false;
				};
				releaseUnusedRepairReservations = () => {
					if (pendingWorkerSpendReservation) releaseReservation(spendBudget, pendingWorkerSpendReservation);
					pendingWorkerSpendReservation = undefined;
					releasePendingPrimaryCapacity();
				};
				const obligationFor = (operation: string, target?: string) => {
					const action = WORKSPACE_WRITE_TOOLS.has(operation) ? "write" : operation === "inspect_workspace" ? "read" : operation === "run_workspace_command" ? "command" : undefined;
					const candidates = compiledTask.acceptanceCriteria.filter((criterion) => criterion.action === action);
					return candidates.find((criterion) => criterion.target === target && target) ?? (candidates.length === 1 ? candidates[0] : undefined);
				};
				const recordFatalRuntimeError = (message: string): void => {
					fatalRuntimeError ??= message;
				};
				const runtimeFailureMessage = (): string | undefined =>
					fatalRuntimeError ?? modelOutputFailure ?? [...recoverableToolErrors.values()].find(({ resolved }) => !resolved)?.message;
				let permissionDenied = false;
				let providerFailed = false;
				let finalMessage: AgentMessage | undefined;
				const reasoning: ReasoningTrace[] = [];
				let currentReasoning = "";
				let currentReasoningTruncated = false;
				let currentText = "";
				const defaultMaxOutputTokens = !model.reasoning || reasoningLevel === "off" ? 16_384
					: reasoningLevel === "high" || reasoningLevel === "xhigh" ? 65_536 : 32_768;
				let currentRequestMaxOutputTokens = Math.min(explicitMaxOutputTokens ?? defaultMaxOutputTokens, model.maxTokens);
				let currentRequestAccounting: ReturnType<typeof createRequestAccounting> | undefined;
				let modelContext: RunModelContext = { contextWindow: model.contextWindow, maxOutputTokens: currentRequestMaxOutputTokens, lastPromptTokens: 0 };
				const toolEventIds = new Map<string, string>();
				const toolStartedAt = new Map<string, number>();
				const toolModelRequestIds = new Map<string, string | undefined>();
				const toolArguments = new Map<string, unknown>();
				const canonicalToolIds = new Map<string, string>();
				const completedToolIds = new Set<string>();
				const successfulTurns = new Set<number>();
				const commandExitCodes: Array<number | null> = [];
				const commandRuns: Array<{ argv: string[]; exitCode: number | null; resultKind?: CommandResultKind; mutationRisk?: CommandMutationRisk }> = [];
				const toolArtifacts = new Map<string, RunArtifact>();
				let modelTurns = 0;
				let unknownToolCalls = 0;
				let toolCalls = 0;
				let currentRepairAttempt = 0;
				let previousPromptTokens = 0;
				let currentPromptKind: "initial" | "verification-repair" | "action-nudge" | "prefix-continuation" | "finalization-nudge" | "progress-nudge" = "initial";
				let lastModelOutcome: string | undefined;
				let modelOutputTruncations = 0;
				let actionNudgeIssued = false;
				let actionNudgeAttempts = 0;
				let proactiveActionNudgeIssued = false;
				let truncationActionNudgeIssued = false;
				let currentResponseToolCallSeen = false;
				let deepSeekPrefixContinuationPending = false;
				let deepSeekPrefixContinuationIssued = false;
				let currentActionNudgeTrigger: "proactive" | "truncation" | undefined;
				const seenToolCallSignatures = new Set<string>();
				let currentTurnHadNovelToolCall = false;
				let nudgeState = initialNudgePolicyState();
				const markActionNudge = (trigger: "proactive" | "truncation"): void => {
					actionNudgeIssued = true;
					actionNudgeAttempts++;
					if (trigger === "proactive") proactiveActionNudgeIssued = true;
					else truncationActionNudgeIssued = true;
					currentActionNudgeTrigger = trigger;
					currentPromptKind = "action-nudge";
				};
				const conversationMessages: AgentMessage[] = options.transcript ? structuredClone(options.transcript.messages) as Message[] : conversation.flatMap((turn) => [
					{ role: "user" as const, content: turn.prompt === undefined ? turn.objective : [{ type: "text" as const, text: turn.prompt }], timestamp: turn.timestamp },
					{
						role: "assistant" as const,
						content: [
							{ type: "text" as const, text: turn.output },
						],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop" as const,
						timestamp: turn.timestamp,
					},
				]);
				// Keep earlier user constraints even when the recent-answer projection omits turns.
				if (!options.transcript) conversationMessages.unshift(...canonicalConversation.slice(0, conversationProjection.omittedTurns).map((turn) => ({ role: "user" as const, content: turn.prompt ?? turn.objective, timestamp: turn.timestamp })));
				const compactedMessages = new Map<string, Message>();
				const primarySystemPrompt = evaluationSystemPrompt(options.evaluationVariant, capabilities.preset, features.tools, capabilities.toolIds, capabilities.canonicalToolIds ?? capabilities.toolIds, { moduleTools: runModuleTools, toolInterface });
				const repairWorker = options.repairWorker;
				const repairPrimaryOutputReserve = Math.min(REPAIR_PRIMARY_OUTPUT_RESERVE, explicitMaxOutputTokens ?? model.maxTokens, model.maxTokens);
				const transformContext = repairWorker ? async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
					let projected = renderRepairReceipts(messages, repairReceipts.values());
					try {
						repairQueue.sort((left, right) => left.ordinal - right.ordinal);
						while (repairQueue.length) {
							const queued = repairQueue.shift()!;
							const repairSecrets = [...knownSecrets, ...privateToolArgumentValues(queued.candidate.toolName, queued.candidate.originalArguments)];
							const failure = recoverableToolErrors.get(queued.candidate.callId);
							const skip = async (reason: string): Promise<void> => {
								await trace.emit("repair.worker.skipped", { failureId: queued.candidate.failureId, contextMode: repairWorker.context, reason }, queued.failureEventId);
							};
							if (!failure || failure.resolved) { await skip("failure-already-resolved"); continue; }
							if (attemptedRepairFingerprints.has(queued.candidate.operationFingerprint)) { await skip("failure-fingerprint-already-attempted"); continue; }
							if (repairWorkerGenerations >= 3) {
								for (const skipped of [queued, ...repairQueue.splice(0)]) {
									await trace.emit("repair.worker.skipped", { failureId: skipped.candidate.failureId, contextMode: repairWorker.context, reason: "run-worker-generation-limit" }, skipped.failureEventId);
								}
								return projected;
							}
							if (Date.now() >= runBudget.deadline || signal?.aborted || options.signal?.aborted) {
								await skip(signal?.aborted || options.signal?.aborted ? "cancelled" : "run-deadline-exceeded");
								return projected;
							}
							if (runBudget.modelTurns + 2 > maxModelTurns) {
								await skip("parent-continuation-model-turn-unavailable");
								return projected;
							}
							if (runBudget.toolCalls >= maxToolCalls) {
								await skip("parent-correction-tool-call-unavailable");
								return projected;
							}
							if (await sourceRevisionFor(queued.candidate.target) !== queued.candidate.sourceRevision) {
								await skip("source-revision-changed");
								continue;
							}
							const remainingOutput = sessionOutputTokenBudget - usage.output - unreconciledWorkerOutputTokens;
							if (remainingOutput <= repairPrimaryOutputReserve) {
								await skip("parent-continuation-output-unavailable");
								return projected;
							}
							const workerMaxOutput = Math.min(2_048, explicitMaxOutputTokens ?? model.maxTokens, model.maxTokens, remainingOutput - repairPrimaryOutputReserve);
							const activeTool = activeTools.find(({ name }) => name === queued.candidate.toolName);
							if (!activeTool || (activeTool.name !== "bash" && gate.decisionFor(activeTool.name) === "DENY")) { await skip("tool-no-longer-eligible"); continue; }
							let primaryMessages: Message[];
							let workerRequest: ReturnType<typeof prepareRequest>;
							let cachePrediction: "none" | "logical-shared-prefix";
							try {
								primaryMessages = await agent.convertToLlm(projected);
								const repairContext = createRepairContext({
									mode: repairWorker.context,
									packet: createRepairPacket(queued.candidate),
									primarySystemPrompt,
									primaryMessages,
									tools: activeTools,
								});
								cachePrediction = repairContext.cachePrediction;
								workerRequest = prepareRequest(repairContext.context, model, workerMaxOutput, undefined, options.contextTokenCounter, contextRetentionTokens, historicalReasoningBilled);
								if (repairWorker.context === "fork" && (workerRequest.omittedResults || workerRequest.compactedArguments)) {
									await skip("exact-fork-does-not-fit");
									continue;
								}
								const primaryOutput = Math.max(1, Math.min(nextMaxOutputTokens(), remainingOutput - workerRequest.maxOutputTokens));
								const primaryRequest = prepareRequest({ systemPrompt: primarySystemPrompt, messages: primaryMessages, tools: activeTools }, model, primaryOutput, undefined, options.contextTokenCounter, contextRetentionTokens, historicalReasoningBilled);
								if (runBudget.modelTurns + 2 > maxModelTurns) { await skip("parent-continuation-model-turn-unavailable"); continue; }
								if (runBudget.toolCalls + 1 > maxToolCalls) { await skip("parent-correction-tool-call-unavailable"); continue; }
								[pendingWorkerSpendReservation, pendingPrimarySpendReservation] = reserveRequests(spendBudget, [
									requestReservation(workerRequest.inputTokens, workerRequest.maxOutputTokens, model.cost),
									// The accepted receipt is bounded to less than 12 KiB and is added before this continuation.
									requestReservation(primaryRequest.inputTokens + 12 * 1_024, primaryRequest.maxOutputTokens, model.cost),
								]);
								runBudget.modelTurns += 2; // Worker plus one reserved primary continuation.
								runBudget.toolCalls++;
								pendingPrimaryModelTurn = true;
								pendingPrimaryToolCall = true;
							} catch (error) {
								await skip(redactAuditString(error instanceof Error ? error.message : String(error), repairSecrets));
								continue;
							}

							attemptedRepairFingerprints.add(queued.candidate.operationFingerprint);
							repairWorkerGenerations++;
							let retainPrimaryCapacity = false;
							try {
							const startedAt = performance.now();
							const workerStarted = await trace.emit("repair.worker.started", {
								failureId: queued.candidate.failureId,
								contextMode: repairWorker.context,
								operationFingerprint: queued.candidate.operationFingerprint,
							}, queued.failureEventId);
							const workerModelEvent = await trace.emit("model.request.started", {
								provider: providerId,
								model: model.id,
								requestRole: "repair-worker",
								contextMode: repairWorker.context,
								maxOutputTokens: workerRequest.maxOutputTokens,
								contextWindow: model.contextWindow,
							}, workerStarted.eventId);
							const accounting = createRequestAccounting(spendBudget, workerRequest.inputTokens, workerRequest.maxOutputTokens, model, pendingWorkerSpendReservation);
							pendingWorkerSpendReservation = undefined;
							let settled = false;
							let workerMessage: AssistantMessage;
							try {
								const providerFetch = options.providerFetch ?? globalThis.fetch;
								const observedProviderFetch: typeof fetch = async (input, init) => {
									await observeProviderRequest(init?.body, "repair-worker", workerModelEvent.eventId);
									return providerFetch(input, init);
								};
								const workerBudgeted = spendBudget.maxCostUsd !== undefined || spendBudget.maxTotalTokens !== undefined;
								const admitWorkerWire = async (body: unknown): Promise<void> => {
									if (typeof body !== "string") throw new Error("Budgeted provider requests require an inspectable JSON payload");
									const reservation = accounting.admitWire(body);
									await trace.emit("context.prepared", { stage: "wire-admission", reservedTokens: reservation.tokens, reservedCostUsd: reservation.costUsd, requestRole: "repair-worker" }, workerModelEvent.eventId);
								};
								const budgetedFetch: typeof fetch = async (input, init) => {
									await admitWorkerWire(init?.body);
									try { return await observedProviderFetch(input, init); } catch(error) { accounting.recordFailure(error); throw error; }
								};
								const workerSignal = AbortSignal.any([options.signal!, ...(signal ? [signal] : [])]);
								const workerTransport = providerTransport(model.api, workerBudgeted ? budgetedFetch : observedProviderFetch, async body => {
									if (workerBudgeted) await admitWorkerWire(body);
									await observeProviderRequest(body, "repair-worker", workerModelEvent.eventId);
								});
								const workerOptions = {
									signal: workerSignal,
									...workerTransport.options,
									...(requestApiKey ? { apiKey: requestApiKey } : {}),
									...(providerId === "opencode-go" ? { headers: { "user-agent": "codetonomy/0.1.0", "x-opencode-session": stableHash(providerSessionId) } } : {}),
									cacheRetention,
									sessionId: providerSessionId,
									onProviderAttempt: async (event: { phase: "started" | "completed" | "failed" | "retry"; attempt: number; status?: number; failureClass?: string; delayMs?: number; usage: "unavailable" }) => {
										if (event.phase === "started") {
											accounting.startAttempt();
											await trace.emit("context.prepared", { inputTokens: workerRequest.inputTokens, maxOutputTokens: workerRequest.maxOutputTokens, omittedResults: workerRequest.omittedResults, compactedArguments: workerRequest.compactedArguments, retentionTokens: workerRequest.retentionTokens, retentionExceeded: workerRequest.retentionExceeded, estimator: workerRequest.estimator, contextWindow: model.contextWindow, pricingKnown, requestRole: "repair-worker" }, workerModelEvent.eventId);
										}
										await trace.emit(event.phase === "retry" ? "provider.retry.scheduled" : `provider.attempt.${event.phase}`, { ...event, provider: providerId, requestRole: "repair-worker" }, workerModelEvent.eventId);
										if (event.phase === "started") await workerTransport.attemptStarted();
									},
									maxRetries: 0,
									maxRetryDelayMs: options.providerMaxRetryDelayMs ?? 5_000,
									maxTokens: workerRequest.maxOutputTokens,
									toolChoice: "none" as const,
									...(model.reasoning && reasoningLevel !== "off" ? { reasoning: reasoningLevel } : {}),
									...(options.onProviderResponse ? { onResponse: options.onProviderResponse } : {}),
								};
								workerMessage = await models.streamSimple(model, workerRequest.context, workerOptions as Parameters<typeof models.streamSimple>[2]).result();
								if (accounting.failure) workerMessage.errorMessage = accounting.failure.message;
        addUsage(usage, workerMessage);
								const workerComplete = workerMessage.stopReason !== "error" && workerMessage.stopReason !== "aborted";
								accounting.settle(workerMessage.usage, workerComplete);
								if (!workerComplete || workerMessage.usage.totalTokens <= 0) unreconciledWorkerOutputTokens += accounting.reservation?.outputTokens ?? 0;
								settled = true;
							} catch (error) {
								if (!settled) {
									accounting.settle({ totalTokens: 0, cost: { total: 0 } }, false);
									unreconciledWorkerOutputTokens += accounting.reservation?.outputTokens ?? 0;
								}
								await trace.emit("budget.reconciled", { ...spendBudget, pricingKnown, requestRole: "repair-worker" }, workerModelEvent.eventId);
								await trace.emit("model.request.failed", { provider: providerId, model: model.id, requestRole: "repair-worker", outcome: accounting.failure ? `local-${accounting.failure.kind}-limit` : signal?.aborted || options.signal?.aborted ? "aborted" : "provider-error", ...(accounting.failure ? { requestSent: false, admission: accounting.failure.details } : {}), durationMs: Math.round((performance.now() - startedAt) * 100) / 100 }, workerModelEvent.eventId);
								await trace.emit("repair.worker.completed", { failureId: queued.candidate.failureId, contextMode: repairWorker.context, disposition: "provider-failure", reason: redactAuditString(error instanceof Error ? error.message : String(error), repairSecrets), cachePrediction, durationMs: Math.round((performance.now() - startedAt) * 100) / 100 }, workerStarted.eventId);
								return projected;
							}

							await trace.emit("budget.reconciled", { ...spendBudget, pricingKnown, requestRole: "repair-worker" }, workerModelEvent.eventId);
							if (workerMessage.usage.cacheRead > 0) await trace.emit("cache.read", { tokens: workerMessage.usage.cacheRead, uncachedInputTokens: workerMessage.usage.input, requestRole: "repair-worker", ...wireRequestData(workerModelEvent.eventId, workerMessage.usage.cacheRead) }, workerModelEvent.eventId);
							if (workerMessage.usage.cacheWrite > 0) await trace.emit("cache.write", { tokens: workerMessage.usage.cacheWrite, uncachedInputTokens: workerMessage.usage.input, requestRole: "repair-worker", ...wireRequestData(workerModelEvent.eventId, workerMessage.usage.cacheRead) }, workerModelEvent.eventId);
							const workerFailed = Boolean(workerMessage.errorMessage) || workerMessage.stopReason === "error" || workerMessage.stopReason === "aborted";
							await trace.emit(workerFailed ? "model.request.failed" : "model.request.completed", {
								provider: providerId,
								model: model.id,
								requestRole: "repair-worker",
								phase: "repair-worker",
								stopReason: workerMessage.stopReason,
								...(accounting.failure ? { requestSent: false, admission: accounting.failure.details } : {}),
								outcome: workerFailed && accounting.failure ? `local-${accounting.failure.kind}-limit` : workerFailed ? workerMessage.stopReason === "aborted" ? "aborted" : "provider-error" : workerMessage.stopReason,
								usage: { ...workerMessage.usage, reported: workerMessage.usage.totalTokens > 0 && !["error", "aborted"].includes(workerMessage.stopReason) },
								...outputDistribution(workerMessage),
								...wireRequestData(workerModelEvent.eventId, workerMessage.usage.cacheRead),
								durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
							}, workerModelEvent.eventId);
							if (workerFailed) {
								await trace.emit("repair.worker.completed", { failureId: queued.candidate.failureId, contextMode: repairWorker.context, disposition: "provider-failure", reason: redactAuditString(workerMessage.errorMessage ?? workerMessage.stopReason, repairSecrets), cachePrediction, usage: { ...workerMessage.usage, reported: workerMessage.usage.totalTokens > 0 && !["error", "aborted"].includes(workerMessage.stopReason) }, durationMs: Math.round((performance.now() - startedAt) * 100) / 100 }, workerStarted.eventId);
								return projected;
							}
							const toolCallReturned = workerMessage.content.some(({ type }) => type === "toolCall");
							const responseText = workerMessage.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
							const parsed = toolCallReturned
								? { kind: "invalid" as const, reason: "worker-returned-tool-call" }
								: parseRepairResponse(responseText, queued.candidate.failureId, queued.candidate.toolName);
							if (parsed.kind !== "propose") {
								await trace.emit("repair.worker.completed", { failureId: queued.candidate.failureId, contextMode: repairWorker.context, disposition: parsed.kind, reason: redactAuditString(parsed.reason, repairSecrets), cachePrediction, usage: { ...workerMessage.usage, reported: workerMessage.usage.totalTokens > 0 && !["error", "aborted"].includes(workerMessage.stopReason) }, cacheReadTokens: workerMessage.usage.cacheRead, cacheWriteTokens: workerMessage.usage.cacheWrite, durationMs: Math.round((performance.now() - startedAt) * 100) / 100 }, workerStarted.eventId);
								return projected;
							}
							if (await sourceRevisionFor(queued.candidate.target) !== queued.candidate.sourceRevision) {
								await trace.emit("repair.worker.completed", { failureId: queued.candidate.failureId, contextMode: repairWorker.context, disposition: "stale", reason: "source-revision-changed", cachePrediction, usage: { ...workerMessage.usage, reported: workerMessage.usage.totalTokens > 0 && !["error", "aborted"].includes(workerMessage.stopReason) }, durationMs: Math.round((performance.now() - startedAt) * 100) / 100 }, workerStarted.eventId);
								return projected;
							}
							const proposal = validateRepairProposal({
								tool: activeTool,
								callId: queued.candidate.callId,
								originalArguments: queued.candidate.originalArguments,
								proposedArguments: parsed.arguments,
								originalTarget: queued.candidate.target,
								targetOf: targetPath,
							});
							if (!proposal.valid) {
								await trace.emit("repair.worker.completed", { failureId: queued.candidate.failureId, contextMode: repairWorker.context, disposition: "invalid", reason: proposal.reason, cachePrediction, usage: { ...workerMessage.usage, reported: workerMessage.usage.totalTokens > 0 && !["error", "aborted"].includes(workerMessage.stopReason) }, durationMs: Math.round((performance.now() - startedAt) * 100) / 100 }, workerStarted.eventId);
								return projected;
							}
							const proposalFingerprint = stableHash({ toolName: queued.candidate.toolName, arguments: proposal.arguments });
							let receipt: RepairReceipt;
							try {
								receipt = createRepairReceipt({ failureId: queued.candidate.failureId, callId: queued.candidate.callId, toolName: queued.candidate.toolName, arguments: proposal.arguments, explanation: parsed.explanation });
							} catch {
								await trace.emit("repair.worker.completed", { failureId: queued.candidate.failureId, contextMode: repairWorker.context, disposition: "invalid", reason: "proposal-receipt-too-large", cachePrediction, usage: { ...workerMessage.usage, reported: workerMessage.usage.totalTokens > 0 && !["error", "aborted"].includes(workerMessage.stopReason) }, durationMs: Math.round((performance.now() - startedAt) * 100) / 100 }, workerStarted.eventId);
								return projected;
							}
							let auditReceipt: RepairReceipt;
							try {
								auditReceipt = createRepairReceipt({ failureId: receipt.failureId, callId: receipt.callId, toolName: receipt.toolName, arguments: redactToolArgumentsForTrace(receipt.toolName, receipt.arguments) as Record<string, unknown>, explanation: redactAuditString(receipt.explanation, repairSecrets) });
							} catch {
								await trace.emit("repair.worker.completed", { failureId: queued.candidate.failureId, contextMode: repairWorker.context, disposition: "invalid", reason: "proposal-audit-receipt-too-large", cachePrediction, usage: { ...workerMessage.usage, reported: workerMessage.usage.totalTokens > 0 && !["error", "aborted"].includes(workerMessage.stopReason) }, durationMs: Math.round((performance.now() - startedAt) * 100) / 100 }, workerStarted.eventId);
								return projected;
							}
							const withReceipt = renderRepairReceipts(projected, [receipt]);
							try {
								prepareRequest({ systemPrompt: primarySystemPrompt, messages: await agent.convertToLlm(withReceipt), tools: activeTools }, model, Math.max(1, Math.min(nextMaxOutputTokens(), sessionOutputTokenBudget - usage.output - unreconciledWorkerOutputTokens)), undefined, options.contextTokenCounter, contextRetentionTokens, historicalReasoningBilled);
							} catch {
								await trace.emit("repair.worker.completed", { failureId: queued.candidate.failureId, contextMode: repairWorker.context, disposition: "invalid", reason: "proposal-receipt-does-not-fit-parent-context", cachePrediction, usage: { ...workerMessage.usage, reported: workerMessage.usage.totalTokens > 0 && !["error", "aborted"].includes(workerMessage.stopReason) }, durationMs: Math.round((performance.now() - startedAt) * 100) / 100 }, workerStarted.eventId);
								return projected;
							}
							repairReceipts.set(queued.candidate.callId, receipt);
							projected = withReceipt;
							const workerCompleted = await trace.emit("repair.worker.completed", { failureId: queued.candidate.failureId, contextMode: repairWorker.context, disposition: "proposed", proposalFingerprint, receipt: auditReceipt.text, cachePrediction, usage: { ...workerMessage.usage, reported: workerMessage.usage.totalTokens > 0 && !["error", "aborted"].includes(workerMessage.stopReason) }, cacheReadTokens: workerMessage.usage.cacheRead, cacheWriteTokens: workerMessage.usage.cacheWrite, durationMs: Math.round((performance.now() - startedAt) * 100) / 100 }, workerStarted.eventId);
							failure.proposalFingerprint = proposalFingerprint;
							failure.proposalEventId = workerCompleted.eventId;
							failure.proposalSourceRevision = queued.candidate.sourceRevision;
							retainPrimaryCapacity = true;
							return projected;
							} finally {
								if (!retainPrimaryCapacity) releasePendingPrimaryCapacity();
								if (pendingWorkerSpendReservation) releaseReservation(spendBudget, pendingWorkerSpendReservation);
								pendingWorkerSpendReservation = undefined;
							}
						}
					} catch {
						// Pi requires transformContext to return a safe projection rather than reject.
						releaseUnusedRepairReservations();
					}
					return projected;
				} : undefined;
				agent = new Agent({
					initialState: {
						systemPrompt: primarySystemPrompt,
						model,
						tools: activeTools,
						messages: conversationMessages,
						thinkingLevel: model.reasoning ? reasoningLevel : "off",
					},
					...(transformContext ? { transformContext } : {}),
					streamFn: (selectedModel, context, streamOptions) => {
						options.signal?.throwIfAborted();
						if (Date.now() >= runBudget.deadline) throw new Error("Run deadline exceeded");
						if (!pendingPrimaryModelTurn && runBudget.modelTurns >= maxModelTurns) { recordFatalRuntimeError(`Model turn budget exhausted (${maxModelTurns})`); throw new Error(fatalRuntimeError); }
						const budgetFailure = budgetLimitMessage();
						if (modelTurns > 0 && budgetFailure) throw new Error(budgetFailure);
						const remainingOutput = sessionOutputTokenBudget - usage.output - unreconciledWorkerOutputTokens;
						if (remainingOutput < 1) { recordFatalRuntimeError(`Session output budget reached (${sessionOutputTokenBudget} tokens)`); throw new Error(fatalRuntimeError); }
						currentRequestMaxOutputTokens = Math.max(1, Math.min(nextMaxOutputTokens(), remainingOutput, pendingPrimarySpendReservation?.outputTokens ?? Infinity));
						const prepared = prepareRequest(context, selectedModel, currentRequestMaxOutputTokens, compactedMessages, options.contextTokenCounter, contextRetentionTokens, historicalReasoningBilled);
						lastPreparedMessages = prepared.context.messages;
						if (pendingPrimaryModelTurn) pendingPrimaryModelTurn = false;
						else runBudget.modelTurns++;
						currentRequestMaxOutputTokens = prepared.maxOutputTokens;
						currentRequestAccounting = createRequestAccounting(spendBudget, prepared.inputTokens, prepared.maxOutputTokens, selectedModel, pendingPrimarySpendReservation);
						pendingPrimarySpendReservation = undefined;
						modelContext = { ...modelContext, maxOutputTokens: Math.max(modelContext.maxOutputTokens, currentRequestMaxOutputTokens), lastPromptTokens: prepared.inputTokens, promptTokensReported: false };
						const useDeepSeekPrefix = deepSeekPrefixContinuationPending;
						deepSeekPrefixContinuationPending = false;
						const providerFetch = options.providerFetch ?? globalThis.fetch;
						const observedProviderFetch: typeof fetch = async (input, init) => {
							await observeProviderRequest(init?.body, "primary", currentModelRequestId);
							return providerFetch(input, init);
						};
						const requestFetch = useDeepSeekPrefix ? deepSeekPrefixFetch(observedProviderFetch) : observedProviderFetch;
						const budgeted = spendBudget.maxCostUsd !== undefined || spendBudget.maxTotalTokens !== undefined;
						const admitPrimaryWire = async (body: unknown): Promise<void> => {
							try {
								if (typeof body !== "string") throw new Error("Budgeted provider requests require an inspectable JSON payload");
								const reservation = currentRequestAccounting!.admitWire(body);
								await trace.emit("context.prepared", { stage: "wire-admission", reservedTokens: reservation.tokens, reservedCostUsd: reservation.costUsd, requestRole: "primary" }, currentModelRequestId);
							} catch (error) {
								recordFatalRuntimeError(redactAuditString(error instanceof Error ? error.message : String(error), knownSecrets));
								throw error;
							}
						};
						const budgetedFetch: typeof fetch = async (input, init) => {
							await admitPrimaryWire(init?.body);
							try { return await requestFetch(input, init); } catch(error) { currentRequestAccounting?.recordFailure(error); throw error; }
						};
						// A message-only proactive nudge keeps tool_choice and thinking unchanged: switching them for one request
						// changes the provider's rendered prefix twice (on the nudge and back), losing the cache both times.
						const forcedActionNudge = currentPromptKind === "action-nudge" && !(currentActionNudgeTrigger === "proactive" && actionNudge.mode === "message-only");
						const nonThinkingActionNudge = forcedActionNudge && modelProfile.protocol.thinkingOffForActionNudge === true;
						const transport = providerTransport(selectedModel.api, budgeted ? budgetedFetch : requestFetch, async body => {
							if (budgeted) await admitPrimaryWire(body);
							await observeProviderRequest(body, "primary", currentModelRequestId);
						});
						return models.streamSimple(selectedModel, prepared.context, {
							...streamOptions,
							...(providerId === "opencode-go" ? { headers: { ...streamOptions?.headers, "user-agent": "codetonomy/0.1.0", "x-opencode-session": stableHash(providerSessionId) } } : {}),
							signal: AbortSignal.any([options.signal!, ...(streamOptions?.signal ? [streamOptions.signal] : [])]),
							...transport.options,
							...(requestApiKey ? { apiKey: requestApiKey } : {}),
							cacheRetention,
							sessionId: providerSessionId,
							onProviderAttempt: async (event) => {
								if (event.phase === "started") {
									currentRequestAccounting!.startAttempt();
									await trace.emit("context.prepared", { inputTokens: prepared.inputTokens, maxOutputTokens: prepared.maxOutputTokens, omittedResults: prepared.omittedResults, supersededResults: prepared.supersededResults, compactedArguments: prepared.compactedArguments, retentionTokens: prepared.retentionTokens, retentionExceeded: prepared.retentionExceeded, estimator: prepared.estimator, contextWindow: selectedModel.contextWindow, pricingKnown, requestRole: "primary" }, currentModelRequestId);
								}
								await trace.emit(event.phase === "retry" ? "provider.retry.scheduled" : `provider.attempt.${event.phase}`, { ...event, provider: providerId, requestRole: "primary" }, currentModelRequestId);
								if (event.phase === "started") await transport.attemptStarted();
							},
							maxRetries: options.providerRetryLimit ?? 2,
							maxRetryDelayMs: options.providerMaxRetryDelayMs ?? 5_000,
							maxTokens: currentRequestMaxOutputTokens,
							...(forcedActionNudge ? {
								toolChoice: "required" as const,
								...(nonThinkingActionNudge ? { reasoning: undefined } : {}),
							} : {}),
							...(options.onProviderResponse ? { onResponse: options.onProviderResponse } : {}),
						});
					},
					sessionId: cacheSessionId,
					toolExecution: "parallel",
					prepareNextTurnWithContext: ({ context, message }) => {
						const nextContext = { ...context, tools: activeTools };
						let evidence: { key: string; guidance: string[]; missingCount: number } | undefined;
						if (message.stopReason === "toolUse" && isActionTask) {
							const checks = verifyOutput("Evidence", undefined, { task: compiledTask, completedToolIds, workspaceEvidenceToolIds, commandExitCodes, commandRuns, fileEvidence }).checks;
							const missing = compiledTask.acceptanceCriteria.filter(c => c.required && checks.some(check => check.id === c.id && !check.passed));
							const guidance = missing.map(c => c.action === "read" && c.target
								? `Read ${JSON.stringify(relative(workspaceRoot, c.target))} using ${toolInterface === "structured" ? "inspect_workspace" : "standalone cat (no chaining, pipes or redirects)"}.`
								: c.command ? `Run the standalone command ${JSON.stringify(c.command)} with cwd ${JSON.stringify(workspaceRoot)}; use read_tool_output for saved output.` : c.description);
							evidence = { key: stableHash(missing.map(({ id, action, target, command, description }) => ({ id, action, target, command, description }))), guidance, missingCount: missing.length };
						}
						const decision = decideNextTurnNudge(nudgeState, {
							stopReason: message.stopReason,
							novelToolCall: currentTurnHadNovelToolCall,
							responseToolCallSeen: currentResponseToolCallSeen,
							...(evidence ? { evidence } : {}),
							modelTurns,
							maxModelTurns,
							workspaceRoot,
							deadlineNear: runBudget.deadline - Date.now() <= finalizationReserveMs(runBudget.deadline - runStartedWallClock),
							toolCallsExhausted: runBudget.toolCalls >= maxToolCalls,
							statusCheckpointEligible: Boolean(options.application) && features.verifierFeedback && currentRepairAttempt === 0,
							canIssueTruncationActionNudge: canIssueTruncationActionNudge(),
							canIssueProactiveActionNudge: canIssueProactiveActionNudge(),
							hasWorkspaceEvidence: hasWorkspaceEvidence(),
							truncationDiscoveryText: truncationDiscoveryNudgeText,
						});
						nudgeState = decision.state;
						const userText = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() });
						if (decision.evidenceReminder !== undefined) nextContext.messages = [...context.messages, userText(decision.evidenceReminder)];
						const action = decision.action;
						if (!action) return { context: nextContext };
						if (action.kind === "truncation-action") {
							markActionNudge("truncation");
							return {
								context: {
									...nextContext,
									messages: [
										...context.messages.map((entry) => entry === message
											? { ...message, content: message.content.filter(({ type }) => type !== "thinking") }
											: entry),
										userText(action.text),
									],
								},
								thinkingLevel: "off",
							};
						}
						if (action.kind === "proactive-action") markActionNudge("proactive");
						else if (action.kind === "budget-finalization" || action.kind === "final-turn") currentPromptKind = "finalization-nudge";
						else if (action.kind === "progress") currentPromptKind = "progress-nudge";
						return { context: { ...nextContext, messages: [...nextContext.messages, userText(action.text)] } };
					},
					shouldStopAfterTurn: ({ message, context }) => {
						// Pi's context hook does not persist injected guidance in agent state.
						// Keep it when verification or output-limit recovery starts another prompt.
						agent.state.messages = context.messages;
						if (fatalRuntimeError || modelOutputFailure || options.signal?.aborted) return true;
						if (message.stopReason === "length" && currentResponseToolCallSeen && currentPromptKind !== "action-nudge") return true;
						const budgetFailure = budgetLimitMessage();
						if (budgetFailure && message.stopReason === "toolUse") {
							modelOutputFailure = budgetFailure;
							return true;
						}
						if (usage.output + unreconciledWorkerOutputTokens >= sessionOutputTokenBudget && message.stopReason === "toolUse") {
							modelOutputFailure = `Session output budget reached (${sessionOutputTokenBudget} tokens)`;
							return true;
						}
						if (maxModelTurns === undefined || modelTurns < maxModelTurns || message.stopReason !== "toolUse") return false;
						turnBudgetExhausted = true;
						return true;
					},
					beforeToolCall: async ({ toolCall, args }) => {
						options.signal?.throwIfAborted();
						if (Date.now() >= runBudget.deadline || !pendingPrimaryToolCall && runBudget.toolCalls >= maxToolCalls) {
							blockedToolCalls.add(toolCall.id);
							recordFatalRuntimeError(Date.now() >= runBudget.deadline ? "Run deadline exceeded" : `Tool-call budget exceeded (${maxToolCalls})`);
							return { block: true, terminate: true, reason: fatalRuntimeError };
						}
						if (pendingPrimaryToolCall) pendingPrimaryToolCall = false;
						else runBudget.toolCalls++;
						if (capabilities.carriedToolIds?.includes(toolCall.name)) {
							blockedToolCalls.add(toolCall.id);
							return { block: true, reason: `${toolCall.name} is not enabled for this turn. It stays listed only so the session's cached prompt is unchanged; use the tools this task grants.` };
						}
						toolCalls++;
						const toolCallSignature = stableHash({ toolId: toolCall.name, arguments: args });
						if (!seenToolCallSignatures.has(toolCallSignature)) {
							seenToolCallSignatures.add(toolCallSignature);
							currentTurnHadNovelToolCall = true;
						}
						let permissionToolId = toolCall.name;
						let operationToolId = toolCall.name;
						let permissionArguments = args;
						let bashTargets: ReturnType<typeof bashPermissionTargets> | undefined;
						let bashPlan: BashCommandPlan | undefined;
						let preciseBashCommand: string[] | undefined;
						let verifiedBashRead = false;
						let bashOperationUnavailable = false;
						if (toolCall.name === "bash") {
							const bashArgs = args as BashToolArguments;
							bashPlan = bashPlanner.plan(toolCall.id, bashArgs);
							const verifiedRead = bashPlan.route === "semantic-native" && bashPlan.readOnly && bashPlanUsesReadOnlySandbox(bashPlan, workspaceRoot);
							verifiedBashRead = verifiedRead;
							if (bashPlan.route === "semantic-native" && bashPlan.semanticArgv && (verifiedRead || bashOperationHasPreciseCommand(bashPlan.operation))) preciseBashCommand = bashPlan.semanticArgv;
							if (verifiedRead && bashPlan.route === "semantic-native") {
								const operation = bashPlan.operation;
								bashTargets = bashPermissionTargets(operation);
								const target = bashPermissionTarget(operation);
								permissionToolId = target.toolId;
								operationToolId = operation.kind === "pwd" ? "bash.pwd" : target.toolId;
								permissionArguments = target.arguments;
								bashOperationUnavailable = bashTargets.some(({ toolId }) => !availableCanonicalToolIds.has(toolId))
									|| operationToolId === "run_workspace_command" && !availableCanonicalToolIds.has(operationToolId);
							} else {
								permissionToolId = bashReadOnlyFallback ? "inspect_workspace" : "run_workspace_command";
								operationToolId = permissionToolId;
								permissionArguments = { argv: createNativeBashArgv(bashArgs.command), cwd: bashArgs.cwd ?? ".", timeoutSeconds: bashArgs.timeoutSeconds ?? 120 };
								if (bashReadOnlyFallback) permissionArguments = { path: bashArgs.cwd ?? "." };
								bashTargets = [{ toolId: bashReadOnlyFallback ? "inspect_workspace" : "run_workspace_command", arguments: permissionArguments as Record<string, unknown> }];
								bashOperationUnavailable = !availableCanonicalToolIds.has(permissionToolId);
							}
							canonicalToolIds.set(toolCall.id, operationToolId);
						}
						const target = targetPath(permissionArguments);
						const targetRevisions = await Promise.all([...new Set((bashTargets ?? []).flatMap(({ arguments: targetArguments }) => {
							const path = targetPath(targetArguments);
							return path ? [path] : [];
						}))].map(async (path) => ({ path, revision: await revisionOf(path) })));
						const operationKey = stableHash({ operation: operationToolId, args: { ...(permissionArguments as Record<string, unknown>), ...(toolCall.name === "bash" ? { bash: args } : {}), ...(target ? { path: target } : {}) }, target, revision: { workspace: workspaceRevision, targets: targetRevisions.length ? targetRevisions : target ? [{ path: target, revision: await revisionOf(target) }] : [] } });
						operationKeys.set(toolCall.id, operationKey);
						recoveryKeys.set(toolCall.id, operationToolId === "read_tool_output"
							? stableHash({ operation: operationToolId, outputId: (args as { outputId?: unknown }).outputId })
							: operationKey);
						toolArguments.set(toolCall.id, permissionArguments);
						const proposalFingerprint = stableHash({ toolName: toolCall.name, arguments: args });
						const proposedFailure = [...recoverableToolErrors].find(([, failure]) => !failure.resolved && failure.proposalFingerprint === proposalFingerprint);
						if (proposedFailure?.[1].proposalSourceRevision && await sourceRevisionFor(proposedFailure[1].target) !== proposedFailure[1].proposalSourceRevision) {
							blockedToolCalls.add(toolCall.id);
							proposedFailure[1].proposalFingerprint = undefined;
							proposedFailure[1].proposalEventId = undefined;
							proposedFailure[1].proposalSourceRevision = undefined;
							repairReceipts.delete(proposedFailure[0]);
							return { block: true, reason: "Repair proposal is stale because its source revision changed" };
						}
						if (proposedFailure) proposalOrigins.set(toolCall.id, proposedFailure[0]);
						if ((failureCounts.get(operationKey) ?? 0) >= 3) {
							blockedToolCalls.add(toolCall.id);
							recordFatalRuntimeError("Repeated unchanged operation failed three times");
							return { block: true, terminate: true, reason: fatalRuntimeError };
						}
						const command = toolCall.name === "bash"
							? preciseBashCommand || createNativeBashArgv((args as BashToolArguments).command)
							: (permissionArguments as { argv?: string[] }).argv;
						const preciseCommand = toolCall.name === "bash"
							? preciseBashCommand
							: command?.length && bashOperationHasPreciseCommand({ kind: "command", argv: command, cwd: ".", timeoutSeconds: 1 }) ? command : undefined;
						if (preciseCommand) preciseCommands.set(toolCall.id, preciseCommand);
						const uncertain = [...recoverableToolErrors.values()].filter((failure) => !failure.resolved && failure.outcome === "effects-unknown");
						const mayMutate = WORKSPACE_WRITE_TOOLS.has(operationToolId) || operationToolId === "run_workspace_command" || toolCall.name === "bash" && permissionMode === "full-access";
						if (uncertain.length && mayMutate) {
							for (const evidence of fileEvidence) evidence.current &&= evidence.revision === await revisionOf(evidence.target);
							const revision = await revisionOf(target);
							const canCorrect = ["write_workspace", "edit_workspace"].includes(operationToolId) && target && uncertain.every(failure => failure.retryCommand && (operationToolId === "write_workspace" && revision === "absent" || revision !== "unknown" && failure.correctionRevisions?.[target] === revision || fileEvidence.some(evidence => evidence.target === target && evidence.action === "read" && evidence.current && evidence.revision === revision && evidence.modelTurn > failure.modelTurn)));
							const canRetry = operationToolId === "run_workspace_command" && preciseCommand && uncertain.every(failure => failure.retryCommand && (failure.corrected || failure.optionalDiagnostic && fileEvidence.some(evidence => evidence.action === "read" && evidence.current && evidence.modelTurn > failure.modelTurn)) && failure.retryCwd === resolve(workspaceRoot, (permissionArguments as { cwd?: string }).cwd ?? ".") && commandMatches(preciseCommand, failure.retryCommand));
							if (canCorrect) approvedCorrections.set(toolCall.id, new Set([...recoverableToolErrors].filter(([, failure]) => uncertain.includes(failure)).map(([id]) => id)));
							if (!canCorrect && !canRetry) {
								blockedToolCalls.add(toolCall.id);
								return { block: true, reason: `Previous mutation has unknown effects. Do not replay arbitrary commands. After a normally settled sandbox command failure, read current files with inspect_workspace or standalone cat; structured edits to freshly read files and the required standalone test/build are allowed. Retrying a failed required test/build also requires a corrective edit. New files may be created only at paths confirmed absent. Timeouts and incomplete executions cannot use this recovery.${target ? ` Read ${JSON.stringify(relative(workspaceRoot, target))} before changing it.` : ""}` };
							}
						}
						if (compiledTask.prohibitions?.some((prohibition) => prohibition.action === "write"
							? WORKSPACE_WRITE_TOOLS.has(operationToolId) && prohibition.target === target || operationToolId === "run_workspace_command"
							: (operationToolId === "run_workspace_command" || toolCall.name === "bash") && !verifiedBashRead && (!preciseCommand || !prohibition.command
								|| !distinctDirectSubcommands(preciseCommand, prohibition.command)))) {
							blockedToolCalls.add(toolCall.id);
							recordFatalRuntimeError("Operation violates an explicit task prohibition");
							return { block: true, terminate: true, reason: fatalRuntimeError };
						}
						const requested = await trace.emit(
							"tool.requested",
							{
								toolId: toolCall.name,
								toolCallId: toolCall.id,
								arguments: redactToolArgumentsForTrace(toolCall.name, args),
								...(operationToolId !== toolCall.name ? { operationId: operationToolId } : {}),
								...(permissionToolId !== operationToolId ? { permissionTargetId: permissionToolId } : {}),
								...(bashTargets && bashTargets.length > 1 ? { permissionTargetIds: bashTargets.map(({ toolId }) => toolId) } : {}),
								...(bashPlan ? { parseStatus: bashPlan.route, planReason: bashPlan.reason } : {}),
							},
							currentModelRequestId,
						);
						toolEventIds.set(toolCall.id, requested.eventId);
						const bashGateResult = bashTargets && !bashOperationUnavailable
							&& !(permissionToolId === "run_workspace_command" && options.writePaths?.length)
							? (await Promise.all(bashTargets.map((target) => gate.check({ toolId: target.toolId, arguments: target.arguments, riskClass: compiledTask.riskClass }, options.signal)))).find(({ allowed }) => !allowed)
								?? { allowed: true, decision: "ALLOW" as const, reason: "All Bash operations are allowed by the permission profile" }
							: undefined;
						const result = maxToolCalls !== undefined && toolCalls > maxToolCalls
							? { allowed: false, decision: "DENY" as const, reason: `Tool-call budget exceeded (${maxToolCalls})` }
							: bashOperationUnavailable
								? { allowed: false, decision: "DENY" as const, reason: "One or more Bash operations are unavailable in this tool profile" }
							: toolCall.name === "bash" && permissionToolId === "run_workspace_command" && options.writePaths?.length
								? { allowed: false, decision: "DENY" as const, reason: "This bounded worker cannot run workspace commands" }
							: bashGateResult ?? await gate.check({ toolId: permissionToolId, arguments: permissionArguments, riskClass: compiledTask.riskClass }, options.signal);
						const permission = await trace.emit(
							result.allowed ? "tool.allowed" : "tool.denied",
							{
								toolId: toolCall.name,
								toolCallId: toolCall.id,
								decision: result.decision,
								reason: result.reason,
								...(operationToolId !== toolCall.name ? { operationId: operationToolId } : {}),
								...(permissionToolId !== operationToolId ? { permissionTargetId: permissionToolId } : {}),
							},
							requested.eventId,
						);
						options.signal?.throwIfAborted();
						if (result.allowed) {
							const started = await trace.emit(
								"tool.started",
								{ toolId: toolCall.name, toolCallId: toolCall.id, ...(operationToolId !== toolCall.name ? { operationId: operationToolId } : {}) },
								permission.eventId,
							);
							toolEventIds.set(toolCall.id, started.eventId);
							toolStartedAt.set(toolCall.id, performance.now());
							toolModelRequestIds.set(toolCall.id, currentModelRequestId);
						} else {
							blockedToolCalls.add(toolCall.id);
							recordFatalRuntimeError(result.reason);
							permissionDenied = true;
							bashPlanner.forget(toolCall.id);
						}
						return result.allowed ? undefined : { block: true, reason: result.reason, terminate: true };
					},
					afterToolCall: async ({ toolCall, result, isError }) => {
						const details = { ...(result.details as Record<string, unknown>), ...executionErrors.get(toolCall.id) };
						const target = targetPath(toolArguments.get(toolCall.id));
						if (isError && details.code === "ENOENT" && compiledTask.acceptanceCriteria.some((criterion) => criterion.action === "exists" && criterion.target === target) && await revisionOf(target) === "absent") {
							const { code: _code, resultKind: _resultKind, mutationRisk: _mutationRisk, executionOutcome: _executionOutcome, ...absenceDetails } = details;
							return {
								isError: false,
								content: [{ type: "text", text: "The requested file is absent. This does not establish a successful read or write." }],
								details: { ...absenceDetails, path: target, evidenceAction: "exists", exists: false, resultKind: "success", mutationRisk: "none", executionOutcome: "known" },
							};
						}
						const reportedKind = ["success", "no-matches", "failure"].includes(String(details.resultKind)) ? details.resultKind as CommandResultKind : undefined;
						const resultKind: CommandResultKind | undefined = isError
							? "failure"
							: reportedKind ?? (typeof details.exitCode === "number" ? details.exitCode === 0 ? "success" : "failure" : undefined);
						const reportedRisk = details.mutationRisk === "none" || details.mutationRisk === "possible" ? details.mutationRisk : undefined;
						const operation = canonicalToolIds.get(toolCall.id) ?? toolCall.name;
						const mutationRisk = reportedRisk ?? (dispatched.has(toolCall.id) && (WORKSPACE_WRITE_TOOLS.has(operation) || operation === "run_workspace_command") ? "possible" : "none");
						const failed = resultKind === "failure" || isError;
						const outcome = details.executionOutcome ?? (!dispatched.has(toolCall.id)
							? "rejected-before-start"
							: failed && mutationRisk === "possible" ? "effects-unknown" : "known");
						const recovery = failed && outcome === "effects-unknown" ? commandRecovery(toolCall.id, details) : undefined;
						const validationCall = recovery && (toolInterface === "bash"
							? `bash with standalone argv ${JSON.stringify(recovery.retryCommand)} and cwd ${JSON.stringify(relative(workspaceRoot, recovery.retryCwd) || ".")}`
							: `run_workspace_command(${JSON.stringify({ argv: recovery.retryCommand, cwd: relative(workspaceRoot, recovery.retryCwd) || "." })})`);
						const recoveryGuidance = recovery
							? `The command settled with a failure; its side effects are not undone. Next: inspect current files with ${toolInterface === "bash" ? "bash using standalone cat" : "inspect_workspace"} before editing. ${recovery.optionalDiagnostic ? "After inspection, run the required validation" : "Make a corrective edit with edit_workspace or write_workspace, then retry"} using ${validationCall}. Do not replay other commands.${typeof details.outputId === "string" ? ` Recover saved output with read_tool_output(${JSON.stringify({ outputId: details.outputId, offset: 0, limit: 16384 })}); use this exact ID, not a guessed ID.` : ""}`
							: `Effects of ${toolCall.name} are uncertain. Reconcile current state before repeating this mutation.`;
						return {
							isError: failed,
							...(failed && outcome === "effects-unknown" ? { content: [...result.content, { type: "text" as const, text: recoveryGuidance }] } : {}),
							details: { ...details, ...(resultKind ? { resultKind, mutationRisk } : {}), executionOutcome: outcome },
						};
					},
				});

				agent.subscribe(async (event: AgentEvent) => {
					if (event.type === "turn_start") {
						modelTurns++;
						currentTurnHadNovelToolCall = false;
						currentModelStartedAt = performance.now();
						const modelEvent = await trace.emit(
							"model.request.started",
							{ provider: providerId, model: model.id, requestRole: "primary", turn: modelTurns, ...(maxModelTurns === undefined ? { stoppingMode: "automatic" } : { maxModelTurns }), contextWindow: model.contextWindow, maxOutputTokens: nextMaxOutputTokens(), lastPromptTokens: modelContext.lastPromptTokens, cacheStrategy: capabilities.preset.cacheStrategy, attempt: currentRepairAttempt, promptKind: currentPromptKind, actionNudge: currentPromptKind === "action-nudge", ...(currentActionNudgeTrigger ? { actionNudgeTrigger: currentActionNudgeTrigger } : {}) },
							runEventId,
						);
						currentModelRequestId = modelEvent.eventId;
						firstTokenSeen = false;
						currentReasoning = "";
						currentReasoningTruncated = false;
						currentText = "";
						currentResponseToolCallSeen = false;
					}
					if (event.type === "message_update") {
						const providerEvent = event.assistantMessageEvent;
						if (providerEvent.type === "thinking_delta" && providerEvent.delta) {
							const remaining = MAX_REASONING_CHARS - currentReasoning.length;
							if (remaining > 0) currentReasoning += providerEvent.delta.slice(0, remaining);
							if (providerEvent.delta.length > remaining) currentReasoningTruncated = true;
							options.onStream?.({ kind: "reasoning", text: redactAuditString(currentReasoning, knownSecrets) });
						}
						if (providerEvent.type === "text_delta" && providerEvent.delta) {
							currentText += providerEvent.delta.slice(0, Math.max(0, MAX_STREAM_TEXT_CHARS - currentText.length));
							options.onStream?.({ kind: "text", text: redactAuditString(currentText, knownSecrets) });
						}
						if (providerEvent.type === "toolcall_end") currentResponseToolCallSeen = true;
						if (!firstTokenSeen &&
							(providerEvent.type === "text_delta" || providerEvent.type === "thinking_delta" || providerEvent.type === "toolcall_delta") &&
							providerEvent.delta
						) {
							firstTokenSeen = true;
							await trace.emit("model.first_token", {
								requestRole: "primary",
								kind: providerEvent.type,
								latencyMs: Math.round((performance.now() - currentModelStartedAt) * 100) / 100,
							}, currentModelRequestId);
						}
					}
					if (event.type === "message_end" && event.message.role === "assistant") {
						if (pendingPrimaryToolCall && !event.message.content.some(({ type }) => type === "toolCall")) {
							runBudget.toolCalls--;
							pendingPrimaryToolCall = false;
						}
						for (const block of event.message.content) if (block.type === "toolCall") {
							const parseStatus = (block as typeof block & { argumentParseStatus?: string }).argumentParseStatus;
							const previous = finalizedToolCalls.get(block.id);
							finalizedToolCalls.set(block.id, { arguments: block.arguments, ...(parseStatus ? { parseStatus } : {}), truncated: event.message.stopReason === "length", ordinal: previous?.ordinal ?? toolCallOrdinal++ });
							toolArguments.set(block.id, block.arguments);
							toolModelRequestIds.set(block.id, currentModelRequestId);
						}
						const admissionFailure = currentRequestAccounting?.failure;
      if (admissionFailure) event.message.errorMessage = admissionFailure.message;
      finalMessage = event.message;
      addUsage(usage, event.message);
						currentRequestAccounting?.settle(event.message.usage, event.message.stopReason !== "error" && event.message.stopReason !== "aborted");
						currentRequestAccounting = undefined;
						await trace.emit("budget.reconciled", { ...spendBudget, pricingKnown, requestRole: "primary" }, currentModelRequestId);
						if (spendBudget.maxTotalTokens !== undefined && spendBudget.totalTokens > spendBudget.maxTotalTokens) modelOutputFailure = `Aggregate token ceiling exceeded (${spendBudget.totalTokens}/${spendBudget.maxTotalTokens})`;
						if (spendBudget.maxCostUsd !== undefined && spendBudget.costUsd > spendBudget.maxCostUsd) modelOutputFailure = `Aggregate cost ceiling exceeded ($${spendBudget.costUsd.toFixed(6)}/$${spendBudget.maxCostUsd})`;
						const modelError = event.message.errorMessage;
						const modelOutcome = modelError
							? admissionFailure ? `local-${admissionFailure.kind}-limit` : event.message.stopReason === "aborted" ? "aborted" : "provider-error"
							: event.message.stopReason === "length" ? "max-output" : event.message.stopReason;
						lastModelOutcome = modelOutcome;
						if (event.message.stopReason === "length") {
							modelOutputTruncations++;
						}
						const promptTokens = promptTokenCount(event.message.usage);
						const promptGrowthTokens = modelError ? 0 : promptTokens - previousPromptTokens;
						if (!modelError && event.message.usage.totalTokens > 0) {
							previousPromptTokens = promptTokens;
							modelContext = { ...modelContext, lastPromptTokens: promptTokens, promptTokensReported: true };
						}
						if (currentReasoning.trim()) {
							const item = { text: redactAuditString(currentReasoning, knownSecrets), truncated: currentReasoningTruncated };
							reasoning.push(item);
							await trace.emit("model.reasoning.completed", { ...item, requestRole: "primary" }, currentModelRequestId);
						}
						if (modelError) {
							recordFatalRuntimeError(redactAuditString(modelError, knownSecrets));
							providerFailed = true;
						}
						if (event.message.usage.cacheRead > 0) {
							await trace.emit("cache.read", { tokens: event.message.usage.cacheRead, uncachedInputTokens: event.message.usage.input, requestRole: "primary", ...wireRequestData(currentModelRequestId, event.message.usage.cacheRead) }, currentModelRequestId);
						}
						if (event.message.usage.cacheWrite > 0) {
							await trace.emit("cache.write", { tokens: event.message.usage.cacheWrite, uncachedInputTokens: event.message.usage.input, requestRole: "primary", ...wireRequestData(currentModelRequestId, event.message.usage.cacheRead) }, currentModelRequestId);
						}
						await trace.emit(modelError ? "model.request.failed" : "model.request.completed", {
							provider: providerId,
							model: model.id,
							requestRole: "primary",
							turn: modelTurns,
							...(maxModelTurns === undefined ? { stoppingMode: "automatic" } : { maxModelTurns }),
							maxOutputTokens: currentRequestMaxOutputTokens,
							stopReason: event.message.stopReason,
							outcome: modelOutcome,
       ...(admissionFailure ? { requestSent: false, admission: admissionFailure.details } : {}),
							promptKind: currentPromptKind,
							phase: currentPromptKind,
							actionNudge: currentPromptKind === "action-nudge",
							...(currentActionNudgeTrigger ? { actionNudgeTrigger: currentActionNudgeTrigger } : {}),
							promptTokens,
							promptGrowthTokens,
							turnBudgetExhausted: maxModelTurns !== undefined && modelTurns >= maxModelTurns && event.message.stopReason === "toolUse",
							usage: { ...event.message.usage, reported: event.message.usage.totalTokens > 0 && !["error", "aborted"].includes(event.message.stopReason) },
							...outputDistribution(event.message),
							...wireRequestData(currentModelRequestId, event.message.usage.cacheRead),
							durationMs: Math.round((performance.now() - currentModelStartedAt) * 100) / 100,
						}, currentModelRequestId);
						currentPromptKind = currentRepairAttempt === 0 ? "initial" : "verification-repair";
						currentActionNudgeTrigger = undefined;
					}
					if (event.type === "tool_execution_start") {
						if (!toolArguments.has(event.toolCallId)) toolArguments.set(event.toolCallId, event.args);
						if (!finalizedToolCalls.has(event.toolCallId)) finalizedToolCalls.set(event.toolCallId, { arguments: event.args, truncated: false, ordinal: toolCallOrdinal++ });
						toolStartedAt.set(event.toolCallId, performance.now());
						toolModelRequestIds.set(event.toolCallId, currentModelRequestId);
					}
					if (event.type === "tool_execution_end") {
						const modelRequestId = toolModelRequestIds.get(event.toolCallId) ?? currentModelRequestId;
						const resultDetails = (event.result as { details?: Record<string, unknown> } | undefined)?.details;
						const resultContent = (event.result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
						const errorMessage = event.isError
							? redactAuditString(resultContent?.find(({ type, text }) => type === "text" && text)?.text ?? `Tool ${event.toolName} failed`, knownSecrets).slice(0, 2_000)
							: undefined;
						const canonicalToolId = typeof resultDetails?.operationId === "string"
							? resultDetails.operationId
							: canonicalToolIds.get(event.toolCallId) ?? event.toolName;
						let parentEventId = toolEventIds.get(event.toolCallId);
						if (!parentEventId) {
							if (!operationKeys.has(event.toolCallId)) {
								if (pendingPrimaryToolCall) pendingPrimaryToolCall = false;
								else runBudget.toolCalls++;
								toolCalls++;
							}
							const requested = await trace.emit("tool.requested", {
								toolId: event.toolName,
								toolCallId: event.toolCallId,
								arguments: redactToolArgumentsForTrace(event.toolName, toolArguments.get(event.toolCallId)),
							}, modelRequestId);
							parentEventId = requested.eventId;
							toolEventIds.set(event.toolCallId, parentEventId);
						}
						const target = targetPath(toolArguments.get(event.toolCallId));
						const obligation = obligationFor(canonicalToolId, target);
						const key = operationKeys.get(event.toolCallId) ?? stableHash({ operation: canonicalToolId, args: toolArguments.get(event.toolCallId), target, revision: target ? await revisionOf(target) : workspaceRevision });
						const recoveryKey = recoveryKeys.get(event.toolCallId) ?? key;
						const outcome = String(resultDetails?.executionOutcome ?? "rejected-before-start");
						const resultKind = ["success", "no-matches", "failure"].includes(String(resultDetails?.resultKind))
							? resultDetails?.resultKind as CommandResultKind
							: event.isError ? "failure" : undefined;
						const reportedMutationRisk = resultDetails?.mutationRisk === "none" || resultDetails?.mutationRisk === "possible"
							? resultDetails.mutationRisk as CommandMutationRisk
							: undefined;
						const mutationRisk = reportedMutationRisk
							?? (dispatched.has(event.toolCallId) && (WORKSPACE_WRITE_TOOLS.has(canonicalToolId) || canonicalToolId === "run_workspace_command") ? "possible" : "none");
						const finalizedCall = finalizedToolCalls.get(event.toolCallId) ?? { arguments: toolArguments.get(event.toolCallId), truncated: false, ordinal: toolCallOrdinal++ };
						const activeTool = activeTools.find(({ name }) => name === event.toolName);
						let schemaValid = false;
						if (activeTool && finalizedCall.parseStatus !== "invalid") try {
							const preparedArguments = activeTool.prepareArguments ? activeTool.prepareArguments(finalizedCall.arguments) : finalizedCall.arguments;
							validateToolArguments(activeTool, {
								type: "toolCall",
								id: event.toolCallId,
								name: event.toolName,
								arguments: preparedArguments as Record<string, unknown>,
							});
							schemaValid = true;
						} catch { /* Pi's validator is the structured classification boundary. */ }
						const repairTargetRevision = event.isError && target ? await revisionOf(target) : undefined;
						const workerEligibility = event.isError
							? classifyRepairFailure({
								knownTool: Boolean(activeTool),
								parseStatus: finalizedCall.parseStatus,
								truncated: finalizedCall.truncated,
								blocked: blockedToolCalls.has(event.toolCallId) || (event.toolName !== "bash" && gate.decisionFor(event.toolName) === "DENY") || Boolean(target && (!isWorkspaceTarget(target) || repairTargetRevision === "protected")),
								cancelled: options.signal?.aborted === true || outcome === "cancelled",
								toolName: event.toolName,
								operationId: canonicalToolId,
								executionOutcome: outcome,
								resultKind,
								mutationRisk,
								schemaValid,
							})
							: { eligible: false, reason: "successful-tool-result" };
						const sourceRevision = workerEligibility.eligible ? await sourceRevisionFor(target, repairTargetRevision) : undefined;
						// Units of work an approval-gated module tool call attempted (delegated child ids): a later
						// successful call of the same tool that covers a failed call's scopes resolves that failure.
						const moduleScopes = reportingModuleToolIds.has(canonicalToolId) && Array.isArray(resultDetails?.recoveryScopes)
							? resultDetails.recoveryScopes.filter((scope): scope is string => typeof scope === "string" && scope.length > 0)
							: [];
						// Verified work a module ran for this run (delegated child runs) counts as this run's change and
						// spend. A failed call's usage arrives through ModuleToolError (onModuleToolFailureUsage) instead.
						const creditModuleWork = async (includeUsage: boolean): Promise<void> => {
							if (!reportingModuleToolIds.has(canonicalToolId)) return;
							for (const path of Array.isArray(resultDetails?.changedPaths) ? resultDetails.changedPaths : []) {
								if (typeof path !== "string" || !path) continue;
								const target = targetPath({ path })!;
								if (!isWorkspaceTarget(target)) continue;
								const revision = await revisionOf(target);
								if (revision === "protected") continue;
								fileEvidence.push({ target, action: revision === "absent" ? "delete" : "write", callId: event.toolCallId, current: revision !== "unknown", revision, modelTurn: modelTurns });
								workspaceRevision++;
							}
							if (includeUsage) addReportedUsage(usage, resultDetails?.additionalUsage);
						};
						if (event.isError && !activeTools.some(({ name }) => name === event.toolName)) {
							// The model already receives the not-found result and the tool list, so a
							// guessed name such as "write" is correctable; only repeated guessing ends the run.
							unknownToolCalls++;
							if (unknownToolCalls > MAX_UNKNOWN_TOOL_CALLS) recordFatalRuntimeError(`Unknown tool called ${unknownToolCalls} times; last was ${event.toolName}`);
						} else if (event.isError) {
							// A failed delegation still reports the verified work its completed children did.
							await creditModuleWork(false);
							failureCounts.set(key, (failureCounts.get(key) ?? 0) + 1);
							recoverableToolErrors.set(event.toolCallId, { toolName: canonicalToolId, message: errorMessage ?? `Tool ${event.toolName} failed`, modelRequestId, modelTurn: modelTurns, key, recoveryKey, target, obligationId: obligation?.id, outcome,
								...(moduleScopes.length ? { recoveryScopes: moduleScopes } : {}),
								...(workerEligibility.eligible ? { schemaRepair: { toolName: event.toolName, arguments: finalizedCall.arguments } } : {}),
								...commandRecovery(event.toolCallId, resultDetails) });
						} else {
							const resultPaths = Array.isArray(resultDetails?.paths) ? resultDetails.paths : [resultDetails?.path];
							for (const path of resultPaths) if (typeof path === "string") {
								const actualTarget = targetPath({ path })!;
								const action = resultDetails?.evidenceAction === "exists" || compiledTask.acceptanceCriteria.some((criterion) => criterion.action === "exists" && criterion.target === actualTarget) ? "exists" : WORKSPACE_WRITE_TOOLS.has(canonicalToolId) ? "write" : "read";
								const revision = await revisionOf(actualTarget);
								fileEvidence.push({ target: actualTarget, action, callId: event.toolCallId, current: revision !== "unknown" && (action === "exists" || revision !== "absent") && (action !== "write" || resultDetails?.changed !== false), revision, modelTurn: modelTurns });
								if (action === "write" && resultDetails?.changed === true && ["write_workspace", "edit_workspace"].includes(canonicalToolId)) for (const [failureId, failure] of recoverableToolErrors) {
									if (!failure.resolved && approvedCorrections.get(event.toolCallId)?.has(failureId)) {
										failure.corrected = true;
										(failure.correctionRevisions ??= {})[actualTarget] = revision;
									}
								}
								if (action === "write") workspaceRevision++;
							}

							completedToolIds.add(canonicalToolId);
							if (typeof resultDetails?.semanticOperationId === "string") completedToolIds.add(resultDetails.semanticOperationId);
							successfulTurns.add(modelTurns);
							await creditModuleWork(true);
							if (canonicalToolId === "run_workspace_command") {
								for (const path of Array.isArray(resultDetails?.changedPaths) ? resultDetails.changedPaths : []) {
									if (typeof path !== "string") continue;
									const target = targetPath({ path })!;
									const revision = await revisionOf(target);
									fileEvidence.push({ target, action: revision === "absent" ? "delete" : "write", callId: event.toolCallId, current: revision !== "unknown", revision, modelTurn: modelTurns });
									workspaceRevision++;
								}
								const exitCode = resultDetails?.exitCode;
								if (exitCode === null || typeof exitCode === "number") {
									commandExitCodes.push(exitCode);
									if (Array.isArray(resultDetails?.argv) && resultDetails.argv.every((value) => typeof value === "string")) {
										commandRuns.push({
											argv: (Array.isArray(resultDetails.semanticArgv) ? resultDetails.semanticArgv : resultDetails.argv) as string[],
											exitCode,
											...(resultKind ? { resultKind } : {}),
											...(mutationRisk ? { mutationRisk } : {}),
										});
									}
								}
							}
						}
						if (parentEventId) {
							const completedEvent = await trace.emit(event.isError ? "tool.failed" : "tool.completed", {
								toolId: event.toolName,
								toolCallId: event.toolCallId,
								...(canonicalToolId !== event.toolName ? { operationId: canonicalToolId } : {}),
								durationMs: Math.round((performance.now() - (toolStartedAt.get(event.toolCallId) ?? performance.now())) * 100) / 100,
								outputBytes: Buffer.byteLength(JSON.stringify(event.result ?? null)),
								// Model-visible text only; outputBytes also counts details, which repeat command output.
								contentBytes: Buffer.byteLength(((event.result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? []).map((block) => block.type === "text" ? block.text ?? "" : "").join("")),
								...(errorMessage ? { message: errorMessage, failureId: event.toolCallId, obligationId: obligation?.id, operationFingerprint: key, repairClass: outcome === "rejected-before-start" ? "representation" : "execution", argumentParseStatus: finalizedCall.parseStatus, failureAttempt: failureCounts.get(key), workerRepairEligible: workerEligibility.eligible, workerRepairKind: workerEligibility.kind, workerRepairReason: workerEligibility.reason } : {}),
								executionOutcome: outcome,
								...(resultKind ? { resultKind } : {}),
								...(mutationRisk ? { mutationRisk } : {}),
								...(resultDetails?.exitCode === undefined ? {} : { exitCode: resultDetails.exitCode }),
								...Object.fromEntries(["preflightDurationMs", "checkpointDurationMs", "subprocessDurationMs", "renderingDurationMs"].flatMap((field) => resultDetails?.[field] === undefined ? [] : [[field, resultDetails[field]]])),
								...Object.fromEntries(["outputId", "outputOwner", "capturedBytes", "readableBytes", "previewTruncated", "omittedBytes", "outputComplete", "checkpointCount"].flatMap((field) => resultDetails?.[field] === undefined ? [] : [[field, resultDetails[field]]])),
								...(canonicalToolId === "search_workspace" && !event.isError
									? {
											backend: resultDetails?.backend ?? "literal",
											budgetExhausted: resultDetails?.budgetExhausted === true,
											...(resultDetails?.backendFallback === undefined ? {} : { backendFallback: resultDetails.backendFallback }),
										}
									: {}),
								...(canonicalToolId === "run_workspace_command" && !event.isError
									? { exitCode: resultDetails?.exitCode }
									: {}),
							}, parentEventId);
							if (typeof completedEvent.data.outputId === "string") issuedOutputIds.add(completedEvent.data.outputId);
							const currentFailure = recoverableToolErrors.get(event.toolCallId);
							if (currentFailure) currentFailure.eventId = completedEvent.eventId;
							if (event.isError && options.repairWorker && workerEligibility.eligible && workerEligibility.kind && activeTool && sourceRevision) {
								const targetLabel = target && isWorkspaceTarget(target) ? relative(workspaceRoot, target) || "." : undefined;
								repairQueue.push({
									ordinal: finalizedCall.ordinal,
									failureEventId: completedEvent.eventId,
									candidate: {
										failureId: completedEvent.eventId,
										callId: event.toolCallId,
										modelRequestId,
										toolName: event.toolName,
										operationFingerprint: key,
										originalArguments: finalizedCall.arguments,
										target,
										...(targetLabel ? { targetLabel } : {}),
										sourceRevision,
										kind: workerEligibility.kind,
										rejection: errorMessage ?? `Tool ${event.toolName} failed`,
										schema: activeTool.parameters,
										objective: compiledTask.objective,
										constraints: { prohibitions: compiledTask.prohibitions ?? [], writePaths: options.writePaths ?? [], riskClass: compiledTask.riskClass },
										acceptanceRule: obligation ?? null,
										toolCeiling: activeTools.map(({ name }) => name),
										permissionProfileId: capabilities.permissionProfileId,
									},
								});
							} else if (event.isError && options.repairWorker) {
								await trace.emit("repair.worker.skipped", { failureId: completedEvent.eventId, contextMode: options.repairWorker.context, reason: workerEligibility.reason }, completedEvent.eventId);
							}
							if (!event.isError) for (const [callId, failure] of recoverableToolErrors) {
								if (failure.resolved || (failure.modelRequestId !== undefined && failure.modelRequestId === modelRequestId) || !failure.eventId) continue;
								if (failure.optionalDiagnostic && failure.retryCommand && canonicalToolId === "run_workspace_command" && resultDetails?.exitCode === 0 && preciseCommands.get(event.toolCallId) && commandMatches(preciseCommands.get(event.toolCallId)!, failure.retryCommand) && resolve(workspaceRoot, String(resultDetails.cwd ?? ".")) === failure.retryCwd) {
									failure.resolved = true;
									await trace.emit("tool.failure.superseded", { failureId: failure.eventId, originatingCallId: callId, correctingCallId: event.toolCallId, reason: "Required validation succeeded after fresh inspection; optional command was not replayed and its side effects were not undone" }, failure.eventId);
									continue;
								}
								const criterion = compiledTask.acceptanceCriteria.find(({ id }) => id === failure.obligationId);
								const fulfilled = criterion && verifyOutput("Evidence", undefined, { task: { ...compiledTask, acceptanceCriteria: [criterion] }, fileEvidence, commandRuns }).checks.some(({ id, passed }) => id === criterion.id && passed);
								const sameOperation = failure.outcome !== "effects-unknown" && failure.toolName === canonicalToolId && (failure.recoveryKey === recoveryKey || Boolean(target && failure.target === target && fileEvidence.some((evidence) => evidence.callId === event.toolCallId && evidence.current)));
								const reconciledWrite = failure.outcome === "effects-unknown" && failure.toolName !== "run_workspace_command" && target === failure.target && canonicalToolId === "inspect_workspace";
								const primarySchemaCorrected = failure.schemaRepair?.toolName === event.toolName && activeTool && validateRepairProposal({
									tool: activeTool, callId: event.toolCallId, originalArguments: failure.schemaRepair.arguments,
									proposedArguments: finalizedCall.arguments as Record<string, unknown>, originalTarget: failure.target, targetOf: targetPath,
								}).valid;
								const moduleCorrected = failure.toolName === canonicalToolId && Boolean(failure.recoveryScopes?.length) && failure.recoveryScopes!.every((scope) => moduleScopes.includes(scope));
								const workerCorrected = proposalOrigins.get(event.toolCallId) === callId
									&& failure.proposalFingerprint === stableHash({ toolName: event.toolName, arguments: finalizedCall.arguments });
								if ((fulfilled && failure.toolName === canonicalToolId) || sameOperation || reconciledWrite || moduleCorrected || workerCorrected || primarySchemaCorrected) {
									failure.resolved = true;
									await trace.emit("tool.failure.resolved", { failureId: failure.eventId, originatingCallId: callId, correctingCallId: event.toolCallId, correctingEventId: completedEvent.eventId, obligationId: failure.obligationId, repairClass: workerCorrected ? "worker-correction" : reconciledWrite ? "reconciliation" : "model-correction", ...(workerCorrected ? { proposalEventId: failure.proposalEventId, workerAssisted: true } : {}) }, failure.eventId);
								}
							}
							if (!event.isError) {
								const candidate = (event.result as { details?: { artifact?: unknown } })?.details?.artifact;
								if (candidate && typeof candidate === "object") {
									const artifact = candidate as Partial<RunArtifact>;
									if (typeof artifact.id === "string" && ["text", "json", "file"].includes(artifact.type ?? "") && typeof artifact.content === "string") {
										const accepted = artifact as RunArtifact;
										toolArtifacts.set(accepted.path ?? accepted.id, accepted);
										await trace.emit("artifact.created", {
											artifactId: accepted.id,
											artifactType: accepted.type,
											path: accepted.path,
										}, completedEvent.eventId);
									}
								}
							}
							toolEventIds.delete(event.toolCallId);
							toolStartedAt.delete(event.toolCallId);
							toolModelRequestIds.delete(event.toolCallId);
							canonicalToolIds.delete(event.toolCallId);
							preciseCommands.delete(event.toolCallId);
							approvedCorrections.delete(event.toolCallId);
							proposalOrigins.delete(event.toolCallId);
							finalizedToolCalls.delete(event.toolCallId);
							blockedToolCalls.delete(event.toolCallId);
						}
					}
				});

				if (options.signal?.aborted) throw new Error("Run aborted");
				const onAbort = () => agent.abort();
				options.signal?.addEventListener("abort", onAbort, { once: true });
				const inputList = compiledTask.inputs.map((input) => `- ${relative(workspaceRoot, input.value)}`).join("\n");
				const inputBlock = inputList ? `\n\n<task-inputs>\n${inputList}\n</task-inputs>` : "";
				const skillBlock = selectedSkills.length
					? `\n\n<activated-skills>\n${selectedSkills.map(({ id, instructions }) => `<skill id=${JSON.stringify(id)}>\n${instructions}\n</skill>`).join("\n")}\n</activated-skills>`
					: "";
				const dependencyBlock = renderVerifiedDependencies(options.verifiedDependencies ?? new Map());
				const permissionBlock = `\n\n<runtime-permissions mode=${JSON.stringify(permissionMode)}>\n${permissionMode === "ask"
					? "Known mutation and command tools require user approval; commands remain workspace-sandboxed."
					: permissionMode === "auto"
						? "Known mutation and command tools are approved automatically; commands remain workspace-sandboxed with network disabled."
						: "Known mutation and command tools are approved automatically; command filesystem and network sandboxing is disabled."}${capabilities.carriedToolIds?.length ? `\nNot enabled for this turn: ${capabilities.carriedToolIds.join(", ")}. Calls to them are refused.` : ""}\n</runtime-permissions>`;
				const userPrompt = `${compiledTask.objective}${inputBlock}${skillBlock}${dependencyBlock}${renderContextTail(contextPacket)}${permissionBlock}`;
				// Keep the existing bounded summary history; image payloads and oversized prompts are not duplicated in sessions.
				if (!images.length && Buffer.byteLength(userPrompt) <= MAX_CONVERSATION_PROMPT_BYTES) options.onUserPrompt?.(userPrompt);
				const needsWorkspaceWrite = compiledTask.requiredCapabilities.includes("workspace-write");
				const needsWorkspaceCommand = compiledTask.requiredCapabilities.includes("workspace-command");
				const isActionTask = needsWorkspaceWrite || needsWorkspaceCommand;
				const hasWorkspaceEvidence = (): boolean => [...completedToolIds].some((toolId) => workspaceInspectionTools.has(toolId));
				const hasRequiredAction = (): boolean => {
					const wroteWorkspace = fileEvidence.some(({ action, current }) => current && (action === "write" || action === "delete"));
					const ranCommand = commandRuns.some(({ exitCode }) => exitCode === 0);
					return (!needsWorkspaceWrite || wroteWorkspace) && (!needsWorkspaceCommand || ranCommand);
				};
				const canIssueProactiveActionNudge = (): boolean => isActionTask && !proactiveActionNudgeIssued && hasWorkspaceEvidence() && !hasRequiredAction();
				const hasAnotherModelTurn = (): boolean => maxModelTurns === undefined || modelTurns < maxModelTurns;
				const canIssueTruncationActionNudge = (): boolean => isActionTask && !truncationActionNudgeIssued && hasAnotherModelTurn() && !hasRequiredAction();
				const canPrefixContinue = (): boolean => modelProfile.protocol.prefixContinuation === true &&!deepSeekPrefixContinuationIssued && hasAnotherModelTurn() && !currentResponseToolCallSeen;
				const nextMaxOutputTokens = (): number => Math.min(explicitMaxOutputTokens ?? defaultMaxOutputTokens, model.maxTokens);
				const maxOutputFailureMessage = (): string => `Model output limit reached (${currentRequestMaxOutputTokens} tokens)`;
				let output = "";
				let verification = verifyOutput("", "Agent has not run", { task: compiledTask });
				let verifiedEvent: HarnessEvent | undefined;
				try {
					const maximumRepairAttempts = features.verifierFeedback ? MAX_REPAIR_ATTEMPTS : 0;
					let outputLimitEncountered = false;
					for (let attempt = 0; attempt <= maximumRepairAttempts; attempt++) {
						if (runBudget.modelTurns >= maxModelTurns) { recordFatalRuntimeError(`Model turn budget exhausted (${maxModelTurns})`); turnBudgetExhausted = true; break; }
						currentRepairAttempt = attempt;
						const prompt = attempt === 0
							? userPrompt
							: `<verification-feedback attempt=${JSON.stringify(attempt)}>\n${verification.checks.filter(({ passed }) => !passed).map(({ id, message }) => `- ${id}: ${message}`).join("\n")}\nAddress only the unresolved checks above. Preserve completed work and every original prohibition and permission ceiling. Inspect current state before changing it, then return a corrected final answer.\n</verification-feedback>`;
						currentPromptKind = attempt === 0 ? "initial" : "verification-repair";
						currentActionNudgeTrigger = undefined;
						await agent.prompt(prompt, attempt === 0 ? images.map((image) => ({ type: "image" as const, ...image })) : undefined);
						output = responseText(finalMessage);
						if (turnBudgetExhausted && !output.trim() && isActionTask && hasWorkspaceEvidence() && hasRequiredAction()) {
							output = "Model turn limit reached before a final answer. See verification checks for task status.";
						}
						let truncated = finalMessage?.role === "assistant" && finalMessage.stopReason === "length";
						if (truncated) {
							outputLimitEncountered = true;
							if (canPrefixContinue()) {
								deepSeekPrefixContinuationIssued = true;
								deepSeekPrefixContinuationPending = true;
								currentPromptKind = "prefix-continuation";
								await agent.prompt(DEEPSEEK_PREFIX_CONTINUATION_TEXT);
								output = responseText(finalMessage);
								truncated = finalMessage?.role === "assistant" && finalMessage.stopReason === "length";
							}
							if (canIssueTruncationActionNudge()) {
								markActionNudge("truncation");
								await agent.prompt(hasWorkspaceEvidence() ? TRUNCATION_ACTION_NUDGE_TEXT : truncationDiscoveryNudgeText);
								output = responseText(finalMessage);
								truncated = finalMessage?.role === "assistant" && finalMessage.stopReason === "length";
							}
							if (truncated) modelOutputFailure = maxOutputFailureMessage();
						}
						const verificationEvent = await trace.emit(
							"verification.started",
							{ verifierIds: capabilities.verifierIds, attempt, outputLimitEncountered, actionNudgeIssued, actionNudgeAttempts },
							runEventId,
						);
						options.signal?.throwIfAborted();
						for (const evidence of fileEvidence) evidence.current &&= evidence.revision === await revisionOf(evidence.target);
						const requiredEvidence = verifyOutput(output, undefined, { task: compiledTask, completedToolIds, workspaceEvidenceToolIds, commandExitCodes, commandRuns, fileEvidence });
						if (requiredEvidence.passed) for (const [callId, failure] of recoverableToolErrors) {
							if (failure.resolved || ![...successfulTurns].some((turn) => turn > failure.modelTurn)) continue;
							const optionalDiagnostic = !failure.obligationId && failure.outcome !== "effects-unknown" && workspaceInspectionTools.has(failure.toolName);
							// A call rejected before it started had no effects; once required evidence is complete it
							// cannot make the run incomplete. Unknown-effects failures still need their own resolution.
							const neverStarted = failure.outcome === "rejected-before-start";
							if (optionalDiagnostic || neverStarted) {
								failure.resolved = true;
								await trace.emit("tool.failure.superseded", { failureId: failure.eventId, originatingCallId: callId, reason: optionalDiagnostic ? "Optional diagnostic; required evidence is complete" : "Rejected before start; required evidence is complete" }, failure.eventId);
							}
						}
						verification = await verifyRunAttempt({
							task: compiledTask,
							output,
							runtimeFailure: runtimeFailureMessage(),
							turnBudgetError: turnBudgetExhausted ? `Model turn budget exhausted (${maxModelTurns})` : undefined,
							evidence: { completedToolIds, workspaceEvidenceToolIds, commandExitCodes, commandRuns, fileEvidence },
							artifacts: [...toolArtifacts.values()],
							workspaceRoot,
							application: options.application,
							knownSecrets,
							signal: options.signal,
						});
						verifiedEvent = await trace.emit(
							verification.passed ? "verification.completed" : "verification.failed",
							{ verification, attempt },
							verificationEvent.eventId,
						);
						if (verification.passed || providerId === "fixture" || permissionDenied || providerFailed || fatalRuntimeError || modelOutputFailure || turnBudgetExhausted || attempt === maximumRepairAttempts) break;
					}
				} finally {
					options.signal?.removeEventListener("abort", onAbort);
				}
				const artifact = { id: randomUUID(), type: "text" as const, content: output };
				if (!pricingKnown || usage.reported !== true) delete usage.cost;
				await trace.emit(
					"artifact.created",
					{ artifactId: artifact.id, artifactType: artifact.type },
					verifiedEvent?.eventId ?? runEventId,
				);
				const changedPaths = [...new Set(fileEvidence
					.filter(({ action, current }) => current && (action === "write" || action === "delete"))
					.map(({ target }) => relative(workspaceRoot, target).split(sep).join("/")))];
				const result: RunResult = {
					runId,
					task: compiledTask,
					capabilities,
					output,
					artifacts: [artifact, ...toolArtifacts.values()],
					verification,
					usage,
					...(changedPaths.length ? { changedPaths } : {}),
					tracePath,
					contextPacket,
					reasoning,
					modelContext,
					model: `${providerId}/${model.id}`,
					durationMs: Math.round((performance.now() - runStartedAt) * 100) / 100,
					...(checkpoint.path ? { checkpointPath: checkpoint.path } : {}),
				};
				completedRun = result;
				usage.cacheSavingsRatio = cacheReadRatio(usage);
				await outputStore.discardUnissued(issuedOutputIds);
				await outputStore.publishIndex();
				await publishSessionCheckpoint();
				releaseUnusedRepairReservations();
				const recovery = buildRecoveryState();
				result.recovery = recovery;
				options.onRecovery?.(recovery);
				// A capture failure is recorded but never changes the run outcome or later captures.
				if (features.moduleContext) for (const module of runModules) {
					if (!module.capture) continue;
					const captureEvent = await trace.emit("module.capture.started", { moduleId: module.id, runId }, runEventId);
					try {
						await module.capture(result, options.signal);
						await trace.emit("module.capture.completed", { moduleId: module.id, runId }, captureEvent.eventId);
					} catch (error) {
						await trace.emit("module.capture.failed", { moduleId: module.id, message: error instanceof Error ? error.message : String(error) }, captureEvent.eventId);
					}
				}
				await trace.emit(verification.passed ? "run.completed" : "run.failed", {
					verified: verification.passed,
					modelTurns,
					modelOutcome: lastModelOutcome,
					terminalReason: fatalRuntimeError ?? modelOutputFailure ?? (turnBudgetExhausted ? `Model turn budget exhausted (${maxModelTurns})` : undefined),
					modelOutputTruncations,
					actionNudgeIssued,
					actionNudgeAttempts,
					proactiveActionNudgeIssued,
					truncationActionNudgeIssued,
					evidenceReminderCount: nudgeState.evidenceReminderCount,
					...(modelOutputFailure ? { modelOutputFailure } : {}),
					turnBudgetExhausted,
					...(maxModelTurns === undefined ? { stoppingMode: "automatic" } : { maxModelTurns }),
					...(maxToolCalls === undefined ? {} : { maxToolCalls }),
					progressNudgeIssued: nudgeState.progressNudgeIssued,
					...(nudgeState.budgetFinalizationNudge ? { budgetFinalizationNudge: nudgeState.budgetFinalizationNudge } : {}),
					artifactIds: [artifact.id, ...[...toolArtifacts.values()].map(({ id }) => id)],
					usage,
					durationMs: result.durationMs,
				}, runEventId);
				await mkdir(runDirectory, { recursive: true });
				await writeRuntimeFileAtomically(join(runDirectory, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
				await options.runStore?.saveRun(result);
				return result;
			} catch (error) {
				const failure = options.signal?.aborted
					? new Error(deadlineController.signal.aborted ? "Run deadline exceeded" : "Run aborted", { cause: error })
					: error;
				const invalidateOutputs = async (reason: string): Promise<boolean> => {
					for (const reference of outputStore.outputReferences()) try {
						await trace.emit("tool.output.invalidated", { ...reference, reason }, runEventId);
					} catch { return false; }
					return true;
				};
				let publicationFailed = false;
				try {
					await outputStore.discardUnissued(issuedOutputIds);
					await outputStore.publishIndex();
				}
				catch {
					publicationFailed = true;
					if (await invalidateOutputs("tool-output index publication failed")) await outputStore.discard().catch(() => undefined);
				}
				// Interruption must retain the current request and completed exchanges
				// for session resume; the checkpoint never implies a successful answer.
				await publishSessionCheckpoint();
				// Drop only reservations this run will never consume, then publish
				// the recovery projection: held in-flight spend and unresolved
				// unknown-effects mutations must survive save/reload unchanged.
				releaseUnusedRepairReservations();
				try { options.onRecovery?.(buildRecoveryState()); } catch {
					// A recovery publication failure must never replace the run's own outcome.
				}
				const message = failure instanceof Error ? failure.message : String(failure);
				const safeMessage = redactAuditString(message, knownSecrets);
				await trace.emit("run.failed", {
					message: safeMessage,
					taskId: task?.id,
				}, runEventId).catch(() => undefined);
				const failedVerification = { passed: false, checks: [{ id: "runtime-failure", passed: false, message: safeMessage }] };
				const failedRun = completedRun
					? { ...completedRun, verification: failedVerification }
					: task && runCapabilities ? {
						runId,
						task,
						capabilities: runCapabilities,
						output: "",
						artifacts: [],
						verification: failedVerification,
						// Retain known spend instead of discarding it; unreported usage
						// keeps reported=false and drops its unverified cost.
						usage: (() => {
							const snapshot = { ...usage, ...(usage.cost ? { cost: { ...usage.cost } } : {}) };
							if (!pricingKnown || snapshot.reported !== true) delete snapshot.cost;
							snapshot.cacheSavingsRatio = cacheReadRatio(snapshot);
							return snapshot;
						})(),
						tracePath,
						model: `${providerId}/${modelId}`,
						durationMs: Math.round((performance.now() - runStartedAt) * 100) / 100,
					} satisfies RunResult : undefined;
				let failedRunOwned = false;
				if (failedRun) try {
					await mkdir(runDirectory, { recursive: true });
					await writeRuntimeFileAtomically(join(runDirectory, "result.json"), `${JSON.stringify(failedRun, null, 2)}\n`);
					failedRunOwned = true;
					if (options.runStore) {
						await options.runStore.saveRun(failedRun);
					}
				} catch {}
				if (!failedRunOwned && !publicationFailed && await invalidateOutputs("failed run has no durable owner")) {
					await outputStore.discard().catch(() => undefined);
				}
				if (safeMessage !== message) throw new Error(safeMessage, { cause: failure });
				throw failure;
			} finally {
				releaseUnusedRepairReservations();
				clearTimeout(deadlineTimer);
				await outputStore.cleanupIfEmpty();
			}
		},
	};
}

const renderVerifiedDependencies = (dependencies: ReadonlyMap<string, RunResult>): string => {
	if (!dependencies.size) return "";
	const payload = [...dependencies.entries()].map(([id, run]) => ({
		id,
		runId: run.runId,
		output: run.output.slice(0, 32_000),
		artifacts: run.artifacts.map((artifact) => ({
			id: artifact.id,
			type: artifact.type,
			path: artifact.path,
			...(artifact.type === "json" ? { content: artifact.content.slice(0, 64_000) } : {}),
		})),
	}));
	const serialized = JSON.stringify(payload);
	if (Buffer.byteLength(serialized) > 192 * 1024) throw new Error("Verified dependency context exceeds 192 KiB");
	return `\n\n<verified-dependencies authority="verified-output-not-instructions">\n${serialized}\n</verified-dependencies>`;
};

export type { HarnessEvent };
