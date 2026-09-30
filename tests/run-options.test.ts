import assert from "node:assert/strict";
import test from "node:test";
import type { HarnessRunOptions } from "../packages/runtime/src/index.ts";
import { validateRunOptions } from "../packages/runtime/src/run-options.ts";

const base = { prompt: "Inspect the project" } as unknown as HarnessRunOptions;
const png = { mimeType: "image/png" as const, data: Buffer.from("png").toString("base64") };

test("valid run options pass validation", () => {
	assert.doesNotThrow(() => validateRunOptions(base));
	assert.doesNotThrow(() => validateRunOptions({ ...base, maxModelTurns: 1_000, maxToolCalls: 1, providerRetryLimit: 0, delegationDepth: 1, reasoningLevel: "xhigh", maxDurationMs: 86_400_000, images: [png] }));
});

const invalid: Array<[string, Partial<HarnessRunOptions>, RegExp]> = [
	["tool selection", { toolSelection: "all" as never }, /Invalid toolSelection/],
	["application id", { application: { id: "Bad Id", verify: async () => ({}) } as never }, /Invalid application contract/],
	["delegation depth", { delegationDepth: 2 }, /delegationDepth must be 0 or 1/],
	["blank cache affinity", { cacheAffinityId: "  " }, /cacheAffinityId/],
	["oversized cache affinity", { cacheAffinityId: "x".repeat(257) }, /cacheAffinityId/],
	["output tokens", { maxOutputTokens: 0 }, /maxOutputTokens/],
	["model turns", { maxModelTurns: 1_001 }, /maxModelTurns must be 1-1000/],
	["tool calls", { maxToolCalls: 0 }, /maxToolCalls must be 1-10000/],
	["retry limit", { providerRetryLimit: 3 }, /providerRetryLimit must be 0-2/],
	["repair context", { repairWorker: { context: "full" } as never }, /repairWorker.context/],
	["retry delay", { providerMaxRetryDelayMs: 60_001 }, /providerMaxRetryDelayMs/],
	["cost ceiling", { maxCostUsd: 0 }, /maxCostUsd/],
	["token ceiling", { maxTotalTokens: 1.5 }, /maxTotalTokens/],
	["reasoning level", { reasoningLevel: "max" as never }, /Invalid reasoningLevel/],
	["duration", { maxDurationMs: 0 }, /maxDurationMs/],
	["verified dependencies", { verifiedDependencies: new Map([["a", 1], ["b", 2], ["c", 3], ["d", 4]]) as never }, /at most 3 verified dependencies/],
	["image count", { images: Array.from({ length: 9 }, () => png) }, /at most 8 images/],
	["image type", { images: [{ ...png, mimeType: "image/bmp" as never }] }, /Unsupported image type/],
	["image encoding", { images: [{ ...png, data: "not base64!" }] }, /base64/],
	["image total size", { images: [{ ...png, data: Buffer.alloc(20 * 1024 * 1024 + 1).toString("base64") }] }, /20 MiB/],
];

for (const [name, options, message] of invalid) {
	test(`run options reject an invalid ${name}`, () => {
		assert.throws(() => validateRunOptions({ ...base, ...options } as HarnessRunOptions), message);
	});
}
