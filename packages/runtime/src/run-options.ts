// Up-front checks on caller-supplied run options. Everything here depends only on
// the options object, so it runs before the harness touches the workspace or a provider.

import { validateRunRecoveryState } from "@agent-harness/contracts";
import { CORE_TOOL_IDS, validateModules } from "@agent-harness/tools";
import type { HarnessRunOptions } from "./index.js";

// Options that existed before modules. Silently ignoring them would drop a feature the caller expects.
const REPLACED_BY_MODULES = ["memoryBackend", "documentSearch", "documentOptions"] as const;

export function validateRunOptions(options: HarnessRunOptions): void {
	for (const key of REPLACED_BY_MODULES) if ((options as unknown as Record<string, unknown>)[key] !== undefined) throw new Error(`${key} was replaced by modules; pass a module in options.modules`);
	if (options.modules !== undefined) validateModules(options.modules, CORE_TOOL_IDS);
	if (options.toolSelection !== undefined && !["minimal", "preset"].includes(options.toolSelection)) throw new Error("Invalid toolSelection");
	if (options.application && (!/^[a-z][a-z0-9-]{0,63}$/.test(options.application.id) || typeof options.application.verify !== "function")) throw new Error("Invalid application contract");
	if (options.delegationDepth !== undefined && (!Number.isInteger(options.delegationDepth) || options.delegationDepth < 0 || options.delegationDepth > 1)) throw new Error("delegationDepth must be 0 or 1");
	if (options.cacheAffinityId !== undefined && (typeof options.cacheAffinityId !== "string" || !options.cacheAffinityId.trim() || Buffer.byteLength(options.cacheAffinityId, "utf8") > 256)) throw new Error("cacheAffinityId must be a non-empty string of at most 256 bytes");
	if (options.maxOutputTokens !== undefined && (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1)) throw new Error("maxOutputTokens must be a positive safe integer");
	if (options.maxModelTurns !== undefined && (!Number.isInteger(options.maxModelTurns) || options.maxModelTurns < 1 || options.maxModelTurns > 1_000)) throw new Error("maxModelTurns must be 1-1000");
	if (options.maxToolCalls !== undefined && (!Number.isInteger(options.maxToolCalls) || options.maxToolCalls < 1 || options.maxToolCalls > 10_000)) throw new Error("maxToolCalls must be 1-10000");
	if (options.providerRetryLimit !== undefined && (!Number.isInteger(options.providerRetryLimit) || options.providerRetryLimit < 0 || options.providerRetryLimit > 2)) throw new Error("providerRetryLimit must be 0-2");
	if (options.repairWorker && !["compact", "fork"].includes(options.repairWorker.context)) throw new Error("repairWorker.context must be compact or fork");
	if (options.providerMaxRetryDelayMs !== undefined && (!Number.isInteger(options.providerMaxRetryDelayMs) || options.providerMaxRetryDelayMs < 1 || options.providerMaxRetryDelayMs > 60_000)) throw new Error("providerMaxRetryDelayMs must be 1-60000");
	if (options.maxCostUsd !== undefined && (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0 || options.maxCostUsd > 1_000_000)) throw new Error("maxCostUsd must be greater than 0 and at most 1000000");
	if (options.maxTotalTokens !== undefined && (!Number.isSafeInteger(options.maxTotalTokens) || options.maxTotalTokens < 1 || options.maxTotalTokens > 1_000_000_000)) throw new Error("maxTotalTokens must be 1-1000000000");
	if (options.recoveryState !== undefined) validateRunRecoveryState(options.recoveryState);
	if (options.reasoningLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh"].includes(options.reasoningLevel)) throw new Error("Invalid reasoningLevel");
	if (options.maxDurationMs !== undefined && (!Number.isSafeInteger(options.maxDurationMs) || options.maxDurationMs < 1 || options.maxDurationMs > 86_400_000)) throw new Error("maxDurationMs must be 1-86400000");
	if ((options.verifiedDependencies?.size ?? 0) > 3) throw new Error("A child run can receive at most 3 verified dependencies");
	const images = options.images ?? [];
	if (images.length > 8) throw new Error("A run can attach at most 8 images");
	let imageBytes = 0;
	for (const image of images) {
		if (!(["image/png", "image/jpeg", "image/webp", "image/gif"] as const).includes(image.mimeType)) throw new Error("Unsupported image type");
		if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new Error("Image data must be base64 encoded");
		imageBytes += Buffer.from(image.data, "base64").length;
	}
	if (imageBytes > 20 * 1024 * 1024) throw new Error("Attached images must total 20 MiB or less");
}
