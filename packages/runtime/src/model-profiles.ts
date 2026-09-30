import type { OpenAICompletionsCompat, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { stableHash } from "@agent-harness/capability-compiler";

/**
 * Model-specific protocol quirks, declared once and layered over the shared
 * agent loop. Profiles never own the loop and never override caller options.
 */
export interface ModelProfileProtocol {
	/** Compat for models the provider catalogue does not know; pi's own compat wins when present. */
	completionsCompat?: Partial<OpenAICompletionsCompat>;
	thinkingLevelMap?: ThinkingLevelMap;
	/** False when the provider drops reasoning from turns before the latest user message. */
	historicalReasoningBilled?: boolean;
	/** Reject reasoningLevel "off". */
	reasoningRequired?: boolean;
	/** Disable thinking on the forced-action retry. */
	thinkingOffForActionNudge?: boolean;
	/** Continue a length-stopped response with an assistant prefix. */
	prefixContinuation?: boolean;
}

export type ReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
const REASONING_LEVELS: readonly ReasoningLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** Evidence-gated tuning (phase 2). A profile may set these only with an `evidence` report. */
export interface ModelProfileBehavior {
	/** Used when the caller sets no reasoningLevel; caller options always win. */
	defaultReasoningLevel?: ReasoningLevel;
	/** Used when the caller sets no actionNudgeMode; caller options always win. */
	actionNudgeMode?: ActionNudgeMode;
}

/**
 * How the proactive action nudge is sent. "forced" also sets tool_choice "required" for that one request (and turns
 * thinking off where the profile says so); "message-only" keeps the request settings unchanged so the provider's
 * cached prefix survives. The truncation nudge is always forced.
 */
export type ActionNudgeMode = "forced" | "message-only";
const ACTION_NUDGE_MODES: readonly ActionNudgeMode[] = ["forced", "message-only"];
export const HARNESS_DEFAULT_ACTION_NUDGE_MODE: ActionNudgeMode = "forced";

/** The harness default when neither the caller nor the profile chooses a level. */
export const HARNESS_DEFAULT_REASONING_LEVEL: ReasoningLevel = "high";

export function effectiveReasoningLevel(callerLevel: ReasoningLevel | undefined, profile: Pick<ResolvedModelProfile, "behavior">): { level: ReasoningLevel; source: "caller" | "profile" | "harness-default" } {
	if (callerLevel !== undefined) return { level: callerLevel, source: "caller" };
	if (profile.behavior.defaultReasoningLevel !== undefined) return { level: profile.behavior.defaultReasoningLevel, source: "profile" };
	return { level: HARNESS_DEFAULT_REASONING_LEVEL, source: "harness-default" };
}

export function effectiveActionNudgeMode(callerMode: ActionNudgeMode | undefined, profile: Pick<ResolvedModelProfile, "behavior">): { mode: ActionNudgeMode; source: "caller" | "profile" | "harness-default" } {
	if (callerMode !== undefined) return { mode: callerMode, source: "caller" };
	if (profile.behavior.actionNudgeMode !== undefined) return { mode: profile.behavior.actionNudgeMode, source: "profile" };
	return { mode: HARNESS_DEFAULT_ACTION_NUDGE_MODE, source: "harness-default" };
}

export interface ModelProfile {
	id: string;
	/** Human-readable name used in errors. */
	label?: string;
	/** Omitted fields match anything; `providers` is matched against the provider kind. */
	match: { providers?: string[]; modelIds?: string[]; modelPrefixes?: string[] };
	protocol: ModelProfileProtocol;
	behavior?: ModelProfileBehavior;
	/** Repo-relative path to the eval report that justified `behavior`. */
	evidence?: string;
}

export interface ResolvedModelProfile {
	id: string;
	label?: string;
	/** Applied profile ids, least specific first. */
	matched: string[];
	/** Hash of the effective settings; equal settings share a hash. */
	hash: string;
	protocol: ModelProfileProtocol;
	behavior: ModelProfileBehavior;
}

// DeepSeek accepts reasoning_effort low/high/max (api-docs.deepseek.com/guides/thinking_mode): minimal and
// low map to low, medium to high. The harness's top level, xhigh, selects max. GLM 5.3 Flash on OpenCode Go
// publishes the same low/high/max efforts.
const LOW_HIGH_MAX_EFFORT: ThinkingLevelMap = { minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max" };

export const MODEL_PROFILES: readonly ModelProfile[] = [
	{ id: "default", match: {}, protocol: {} },
	// DeepSeek drops reasoning from turns before the latest user message server-side (verified on OpenCode Go).
	{ id: "deepseek/*", match: { providers: ["deepseek"] }, protocol: { prefixContinuation: true } },
	{ id: "deepseek/deepseek-*", match: { providers: ["deepseek"], modelPrefixes: ["deepseek-"] }, protocol: { historicalReasoningBilled: false, thinkingLevelMap: LOW_HIGH_MAX_EFFORT } },
	{
		id: "opencode-go/deepseek-*",
		match: { providers: ["opencode-go"], modelPrefixes: ["deepseek-"] },
		protocol: {
			completionsCompat: { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" },
			historicalReasoningBilled: false,
			thinkingOffForActionNudge: true,
			thinkingLevelMap: LOW_HIGH_MAX_EFFORT,
		},
		// A forced nudge switched tool_choice and thinking for one request, breaking the cached prefix twice;
		// message-only nudges were still answered with a tool call in every A/B run.
		behavior: { actionNudgeMode: "message-only" },
		evidence: "live-projects/stable-nudge-2026-09-28/REPORT.md",
	},
	{ id: "opencode-go/glm-*", match: { providers: ["opencode-go"], modelPrefixes: ["glm-"] }, protocol: { completionsCompat: { thinkingFormat: "zai", supportsReasoningEffort: false } } },
	{
		id: "opencode-go/glm-5.3-flash",
		label: "OpenCode Go GLM 5.3 Flash",
		match: { providers: ["opencode-go"], modelIds: ["glm-5.3-flash"] },
		protocol: { completionsCompat: { thinkingFormat: "openai", supportsReasoningEffort: true }, thinkingLevelMap: LOW_HIGH_MAX_EFFORT, reasoningRequired: true },
	},
	{ id: "opencode-go/qwen-plus", match: { providers: ["opencode-go"], modelIds: ["qwen3.5-plus", "qwen3.6-plus"] }, protocol: { completionsCompat: { thinkingFormat: "qwen" } } },
	{ id: "opencode-go/kimi-k2.6", match: { providers: ["opencode-go"], modelIds: ["kimi-k2.6"] }, protocol: { completionsCompat: { thinkingFormat: "deepseek", supportsReasoningEffort: false } } },
];

const PROFILE_KEYS = new Set(["id", "label", "match", "protocol", "behavior", "evidence"]);
const MATCH_KEYS = new Set(["providers", "modelIds", "modelPrefixes"]);
const PROTOCOL_KEYS = new Set<keyof ModelProfileProtocol>(["completionsCompat", "thinkingLevelMap", "historicalReasoningBilled", "reasoningRequired", "thinkingOffForActionNudge", "prefixContinuation"]);
const BEHAVIOR_KEYS = new Set<keyof ModelProfileBehavior>(["defaultReasoningLevel", "actionNudgeMode"]);

const unknownKeys = (value: object, allowed: Set<string>): string[] => Object.keys(value).filter(key => !allowed.has(key));
const overlaps = (a?: string[], b?: string[]): boolean => !a || !b ? !a && !b : a.some(item => b.includes(item));

export function validateModelProfiles(profiles: readonly ModelProfile[]): void {
	const ids = new Set<string>();
	for (const profile of profiles) {
		if (ids.has(profile.id)) throw new Error(`Duplicate profile id: ${profile.id}`);
		ids.add(profile.id);
		const unknown = [
			...unknownKeys(profile, PROFILE_KEYS),
			...unknownKeys(profile.match ?? {}, MATCH_KEYS).map(key => `match.${key}`),
			...unknownKeys(profile.protocol ?? {}, PROTOCOL_KEYS as Set<string>).map(key => `protocol.${key}`),
			...unknownKeys(profile.behavior ?? {}, BEHAVIOR_KEYS as Set<string>).map(key => `behavior.${key}`),
		];
		if (unknown.length) throw new Error(`Unknown model profile keys in ${profile.id}: ${unknown.join(", ")}`);
		const level = profile.behavior?.defaultReasoningLevel;
		if (level !== undefined && !REASONING_LEVELS.includes(level)) throw new Error(`Invalid defaultReasoningLevel in ${profile.id}: ${String(level)}`);
		const nudgeMode = profile.behavior?.actionNudgeMode;
		if (nudgeMode !== undefined && !ACTION_NUDGE_MODES.includes(nudgeMode)) throw new Error(`Invalid actionNudgeMode in ${profile.id}: ${String(nudgeMode)}`);
		if (profile.behavior && Object.keys(profile.behavior).length && !profile.evidence?.trim()) throw new Error(`Profile ${profile.id} sets behavior without evidence`);
		if (level === "off" && profile.protocol.reasoningRequired) throw new Error(`Profile ${profile.id} defaults to reasoning off but requires reasoning`);
		if (profile.match.modelIds && profile.match.modelPrefixes) throw new Error(`Ambiguous profile ${profile.id}: match exact ids or prefixes, not both`);
	}
	const fallback = profiles.find(profile => profile.id === "default");
	if (!fallback || Object.keys(fallback.match).length) throw new Error("Model profiles require a default profile that matches every model");
	for (const [index, a] of profiles.entries()) {
		for (const b of profiles.slice(index + 1)) {
			if (!overlaps(a.match.providers, b.match.providers)) continue;
			const shared = (a.match.modelIds ?? []).some(id => b.match.modelIds?.includes(id))
				|| (a.match.modelPrefixes ?? []).some(prefix => b.match.modelPrefixes?.includes(prefix))
				|| (!a.match.modelIds && !a.match.modelPrefixes && !b.match.modelIds && !b.match.modelPrefixes);
			if (shared) throw new Error(`Ambiguous model profiles ${a.id} and ${b.id}`);
		}
	}
}

validateModelProfiles(MODEL_PROFILES);

/** Specificity: default < provider-wide < prefix (longer wins) < exact id; provider-scoped beats unscoped. */
function specificity(profile: ModelProfile, modelId: string): number {
	const scoped = profile.match.providers ? 1 : 0;
	if (profile.match.modelIds) return 3_000_000 + scoped;
	if (profile.match.modelPrefixes) {
		const prefix = Math.max(...profile.match.modelPrefixes.filter(item => modelId.startsWith(item)).map(item => item.length));
		return 2_000_000 + prefix * 2 + scoped;
	}
	return profile.id === "default" ? 0 : 1_000_000 + scoped;
}

function matches(profile: ModelProfile, provider: string, modelId: string): boolean {
	const { providers, modelIds, modelPrefixes } = profile.match;
	return (!providers || providers.includes(provider))
		&& (!modelIds || modelIds.includes(modelId))
		&& (!modelPrefixes || modelPrefixes.some(prefix => modelId.startsWith(prefix)));
}

export function resolveModelProfile(input: { provider: string; modelId: string }, profiles: readonly ModelProfile[] = MODEL_PROFILES): ResolvedModelProfile {
	const applied = profiles
		.filter(profile => matches(profile, input.provider, input.modelId))
		.sort((a, b) => specificity(a, input.modelId) - specificity(b, input.modelId));
	const protocol: ModelProfileProtocol = {};
	let behavior: ModelProfileBehavior = {};
	for (const profile of applied) {
		for (const [key, value] of Object.entries(profile.protocol) as Array<[keyof ModelProfileProtocol, unknown]>) {
			if (value === undefined) continue;
			(protocol as Record<string, unknown>)[key] = key === "completionsCompat" ? { ...protocol.completionsCompat, ...(value as object) } : value;
		}
		behavior = { ...behavior, ...profile.behavior };
	}
	const label = applied.findLast(profile => profile.label)?.label;
	return {
		id: applied.at(-1)!.id,
		...(label ? { label } : {}),
		matched: applied.map(profile => profile.id),
		hash: stableHash({ protocol, behavior }),
		protocol,
		behavior,
	};
}
