import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CompiledCapabilities } from "@agent-harness/contracts";
import { writeRuntimeFileAtomically } from "./checkpoint.js";

const MAX_SHAPE_BYTES = 16 * 1024;

export interface RuntimeCacheShape {
	version: 1;
	providerId: string;
	modelId: string;
	cachePrefixHash: string;
	toolBundleHash: string;
	skillPackHash: string;
	permissionProfileId?: string;
	cacheAffinityIdHash?: string;
}

export interface CacheLookup {
	status: "new" | "unchanged" | "invalidated";
	changed: string[];
	path?: string;
}

export interface CacheAffinityInput {
	scopeId: string;
	providerId: string;
	modelId: string;
	cachePrefixHash: string;
	toolBundleHash: string;
	permissionProfileId: string;
}

/**
 * Produce a provider-safe affinity key from an opaque local scope. The scope
 * is used only as an HMAC key; raw session, user, and workspace identifiers
 * never leave the harness.
 */
export function deriveCacheAffinityId(input: CacheAffinityInput): string {
	if (!input.scopeId.trim()) throw new Error("Cache affinity scope must not be empty");
	const payload = JSON.stringify({
		providerId: input.providerId,
		modelId: input.modelId,
		cachePrefixHash: input.cachePrefixHash,
		toolBundleHash: input.toolBundleHash,
		permissionProfileId: input.permissionProfileId,
	});
	return `codetonomy-${createHmac("sha256", input.scopeId).update(payload).digest("hex")}`;
}

export type CacheMissReason = "first-request" | "prefix-changed" | "affinity-changed" | "unexplained-provider-miss" | "none";

export interface WireRequestObservation {
	version: 1;
	providerId: string;
	modelId: string;
	wireRequestHash: string;
	wireBytes: number;
	wireEstimatedTokens: number;
	stablePrefixHash: string;
	stablePrefixBytes: number;
	stablePrefixEstimatedTokens: number;
	dynamicTailHash: string;
	dynamicTailBytes: number;
	dynamicTailEstimatedTokens: number;
	toolSchemaHash: string;
	toolOrderHash: string;
	enabledToolSetHash: string;
	systemPromptHash: string;
	stableConfigurationHash: string;
	affinityIdHash?: string;
	localSessionIdHash?: string;
}

const hashBytes = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const json = (value: unknown): string => JSON.stringify(value) ?? "null";
const hashJson = (value: unknown): string => hashBytes(json(value));
const estimatedTokens = (bytes: number): number => Math.ceil(bytes / 4);

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isStablePromptEntry = (value: unknown): boolean => {
	if (!isRecord(value)) return false;
	const role = value.role ?? value.type;
	return role === "system" || role === "developer";
};

const promptParts = (body: Record<string, unknown>): { stable: unknown[]; dynamic: unknown[] } => {
	for (const field of ["messages", "input", "contents"] as const) {
		const entries = body[field];
		if (!Array.isArray(entries)) continue;
		let stableCount = 0;
		while (stableCount < entries.length && isStablePromptEntry(entries[stableCount])) stableCount++;
		return { stable: entries.slice(0, stableCount), dynamic: entries.slice(stableCount) };
	}
	return { stable: [], dynamic: [] };
};

const providerStableConfiguration = (body: Record<string, unknown>): Record<string, unknown> => {
	const dynamicFields = new Set(["messages", "input", "contents", "max_tokens", "max_completion_tokens", "max_output_tokens", "stream", "prompt_cache_key", "session_id", "metadata"]);
	return Object.fromEntries(Object.entries(body).filter(([key]) => !dynamicFields.has(key)));
};

/** Derive content-free cache telemetry from the exact serialized provider body. */
export function observeWireRequest(
	payload: string,
	input: { providerId: string; modelId: string; affinityId?: string; localSessionId?: string },
): WireRequestObservation {
	if (typeof payload !== "string") throw new Error("Provider payload must be a string");
	const body = JSON.parse(payload) as unknown;
	if (!isRecord(body)) throw new Error("Provider payload must be a JSON object");
	const tools = Array.isArray(body.tools) ? body.tools : [];
	const { stable, dynamic } = promptParts(body);
	const hasPromptArray = ["messages", "input", "contents"].some((field) => Array.isArray(body[field]));
	const stableBody = { ...providerStableConfiguration(body) };
	for (const field of ["messages", "input", "contents"] as const) if (Array.isArray(body[field])) stableBody[field] = stable;
	const stablePrefix = json(stableBody);
	const dynamicTail = json(hasPromptArray ? dynamic : body.contents ?? body.input ?? body.messages ?? []);
	const toolSchema = json(tools);
	const toolNames = tools.map((tool) => isRecord(tool)
		&& isRecord(tool.function) && typeof tool.function.name === "string" ? tool.function.name
		: isRecord(tool) && typeof tool.name === "string" ? tool.name : "");
	const bytes = Buffer.byteLength(payload, "utf8");
	const stableBytes = Buffer.byteLength(stablePrefix, "utf8");
	const dynamicBytes = Buffer.byteLength(dynamicTail, "utf8");
	return {
		version: 1,
		providerId: input.providerId,
		modelId: input.modelId,
		wireRequestHash: hashBytes(payload),
		wireBytes: bytes,
		wireEstimatedTokens: estimatedTokens(bytes),
		stablePrefixHash: hashBytes(stablePrefix),
		stablePrefixBytes: stableBytes,
		stablePrefixEstimatedTokens: estimatedTokens(stableBytes),
		dynamicTailHash: hashBytes(dynamicTail),
		dynamicTailBytes: dynamicBytes,
		dynamicTailEstimatedTokens: estimatedTokens(dynamicBytes),
		toolSchemaHash: hashBytes(toolSchema),
		toolOrderHash: hashBytes(toolNames.join("\u0000")),
		enabledToolSetHash: hashJson([...new Set(toolNames)].sort()),
		systemPromptHash: hashJson({ entries: stable, ...(body.system === undefined ? {} : { system: body.system }), ...(body.systemInstruction === undefined ? {} : { systemInstruction: body.systemInstruction }), ...(body.system_instruction === undefined ? {} : { system_instruction: body.system_instruction }) }),
		stableConfigurationHash: hashJson(providerStableConfiguration(body)),
		...(input.affinityId ? { affinityIdHash: hashBytes(input.affinityId) } : {}),
		...(input.localSessionId ? { localSessionIdHash: hashBytes(input.localSessionId) } : {}),
	};
}

export function commonPrefixBytes(previous: string, next: string): number {
	const left = Buffer.from(previous, "utf8");
	const right = Buffer.from(next, "utf8");
	const limit = Math.min(left.length, right.length);
	let index = 0;
	while (index < limit && left[index] === right[index]) index++;
	return index;
}

export function classifyCacheMiss(previous: WireRequestObservation | undefined, next: WireRequestObservation, providerCacheRead = 0): CacheMissReason {
	if (!previous) return "first-request";
	if (previous.providerId !== next.providerId || previous.modelId !== next.modelId || previous.affinityIdHash !== next.affinityIdHash) return "affinity-changed";
	if (previous.stablePrefixHash !== next.stablePrefixHash) return "prefix-changed";
	return providerCacheRead > 0 ? "none" : "unexplained-provider-miss";
}

export const captureCacheShape = (
	providerId: string,
	modelId: string,
	capabilities: CompiledCapabilities,
	options: { cacheAffinityId?: string } = {},
): RuntimeCacheShape => ({
	version: 1,
	providerId,
	modelId,
	cachePrefixHash: capabilities.cachePrefixHash,
	toolBundleHash: capabilities.toolBundleHash,
	skillPackHash: capabilities.skillPackHash,
	permissionProfileId: capabilities.permissionProfileId,
	...(options.cacheAffinityId ? { cacheAffinityIdHash: hashBytes(options.cacheAffinityId) } : {}),
});

export function compareCacheShapes(previous: RuntimeCacheShape, next: RuntimeCacheShape): string[] {
	const changed: string[] = [];
	if (previous.providerId !== next.providerId) changed.push("provider");
	if (previous.modelId !== next.modelId) changed.push("model");
	if (previous.toolBundleHash !== next.toolBundleHash) changed.push("tools");
	if (previous.permissionProfileId !== next.permissionProfileId) changed.push("permission");
	if (previous.cacheAffinityIdHash !== next.cacheAffinityIdHash) changed.push("affinity");
	// Optional/task skills intentionally do not invalidate the stable prefix.
	if (previous.cachePrefixHash !== next.cachePrefixHash && !changed.length) changed.push("stable-prefix");
	return changed;
}

const validShape = (value: unknown): value is RuntimeCacheShape => {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const shape = value as Partial<RuntimeCacheShape>;
	return shape.version === 1
		&& [shape.providerId, shape.modelId, shape.cachePrefixHash, shape.toolBundleHash, shape.skillPackHash]
			.every((item) => typeof item === "string" && item.length > 0)
		&& (shape.permissionProfileId === undefined || typeof shape.permissionProfileId === "string" && shape.permissionProfileId.length > 0)
		&& (shape.cacheAffinityIdHash === undefined || /^[0-9a-f]{64}$/.test(shape.cacheAffinityIdHash));
};

export async function lookupAndStoreCacheShape(
	traceDirectory: string,
	sessionId: string | undefined,
	next: RuntimeCacheShape,
): Promise<CacheLookup> {
	if (!sessionId) return { status: "new", changed: [] };
	const key = createHash("sha256").update(sessionId).digest("hex");
	const path = join(dirname(resolve(traceDirectory)), "cache-shapes", `${key}.json`);
	let previous: RuntimeCacheShape | undefined;
	try {
		const raw = await readFile(path);
		if (raw.length > MAX_SHAPE_BYTES) throw new Error("Cache shape exceeds 16 KiB");
		const parsed: unknown = JSON.parse(raw.toString("utf8"));
		if (!validShape(parsed)) throw new Error("Invalid cache shape");
		previous = parsed;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await writeRuntimeFileAtomically(path, `${JSON.stringify(next, null, 2)}\n`);
	if (!previous) return { status: "new", changed: [], path };
	const changed = compareCacheShapes(previous, next);
	return { status: changed.length ? "invalidated" : "unchanged", changed, path };
}
