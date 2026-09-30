import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createHarness, type HarnessModelMetadata } from "../packages/runtime/src/index.ts";
import { classifyCacheMiss, commonPrefixBytes, deriveCacheAffinityId, observeWireRequest } from "../packages/runtime/src/cache-shape.ts";
import { prepareRequest } from "../packages/runtime/src/request-budget.ts";
import { tempDirs } from "./support/temp.ts";

const temporaryDirectory = tempDirs();

const metadata: HarnessModelMetadata = {
	id: "cache-test-model",
	name: "Cache test model",
	api: "openai-completions",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 16_384,
	maxTokens: 2_048,
	cacheStrategy: "AUTO_PREFIX",
};

test("wire observations separate stable prefix, dynamic tail, and scoped affinity", () => {
	const base = JSON.stringify({
		model: "cache-test-model",
		messages: [
			{ role: "system", content: "stable host instructions" },
			{ role: "user", content: "first task" },
		],
		tools: [{ type: "function", function: { name: "inspect", parameters: { type: "object" } } }],
		max_tokens: 128,
		stream: true,
	});
	const changedTail = JSON.stringify({
		model: "cache-test-model",
		messages: [
			{ role: "system", content: "stable host instructions" },
			{ role: "user", content: "second task" },
		],
		tools: [{ type: "function", function: { name: "inspect", parameters: { type: "object" } } }],
		max_tokens: 128,
		stream: true,
	});
	const reorderedTools = JSON.stringify({
		model: "cache-test-model",
		messages: [
			{ role: "system", content: "stable host instructions" },
			{ role: "user", content: "second task" },
		],
		tools: [{ type: "function", function: { name: "write", parameters: { type: "object" } } }, { type: "function", function: { name: "inspect", parameters: { type: "object" } } }],
		max_tokens: 128,
		stream: true,
	});
	const first = observeWireRequest(base, { providerId: "test", modelId: "cache-test-model", affinityId: "provider-affinity" });
	const second = observeWireRequest(changedTail, { providerId: "test", modelId: "cache-test-model", affinityId: "provider-affinity" });
	const reordered = observeWireRequest(reorderedTools, { providerId: "test", modelId: "cache-test-model", affinityId: "provider-affinity" });
	assert.equal(first.stablePrefixHash, second.stablePrefixHash);
	assert.ok(first.stablePrefixBytes <= first.wireBytes);
	assert.notEqual(first.wireRequestHash, second.wireRequestHash);
	assert.notEqual(first.dynamicTailHash, second.dynamicTailHash);
	assert.notEqual(first.toolOrderHash, reordered.toolOrderHash);
	assert.notEqual(first.stablePrefixHash, reordered.stablePrefixHash);
	assert.ok(commonPrefixBytes(base, changedTail) > 0);
	assert.equal(classifyCacheMiss(undefined, first), "first-request");
	assert.equal(classifyCacheMiss(first, second, 0), "unexplained-provider-miss");
	assert.equal(classifyCacheMiss(first, second, 10), "none");
	assert.equal(classifyCacheMiss(second, reordered, 0), "prefix-changed");
	const serialized = JSON.stringify(first);
	assert.doesNotMatch(serialized, /stable host instructions|first task|provider-affinity/);
	assert.match(first.affinityIdHash ?? "", /^[0-9a-f]{64}$/);
});

test("cache affinity is stable only within a compatible local scope", () => {
	const input = { scopeId: "scope-a", providerId: "provider", modelId: "model", cachePrefixHash: "prefix", toolBundleHash: "tools", permissionProfileId: "workspace-read" };
	const same = deriveCacheAffinityId(input);
	assert.equal(same, deriveCacheAffinityId({ ...input }));
	assert.notEqual(same, deriveCacheAffinityId({ ...input, scopeId: "scope-b" }));
	assert.notEqual(same, deriveCacheAffinityId({ ...input, modelId: "other-model" }));
	assert.notEqual(same, deriveCacheAffinityId({ ...input, permissionProfileId: "workspace-write" }));
	assert.match(same, /^codetonomy-[0-9a-f]{64}$/);
});

test("provider boundary records content-free wire telemetry and output distribution", async () => {
	const root = await temporaryDirectory("cache-quality-runtime-");
	const requests: Array<{ body: string; headers: Headers }> = [];
	const providerFetch: typeof fetch = async (_input, init) => {
		requests.push({ body: String(init?.body), headers: new Headers(init?.headers) });
		const base = { id: "cache-quality-response", object: "chat.completion.chunk", created: 1, model: metadata.id };
		return new Response([
			`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] })}\n\n`,
			`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } })}\n\n`,
			"data: [DONE]\n\n",
		].join(""), { headers: { "content-type": "text/event-stream" } });
	};
	const events: Array<{ type: string; data: Record<string, unknown> }> = [];
	const result = await createHarness().run({
		objective: "Return a short answer",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "cache-test-provider",
		modelId: metadata.id,
		providerConfiguration: { id: "cache-test-provider", name: "Cache test provider", kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", modelMetadata: metadata },
		providerFetch,
		sessionId: "logical-session-secret",
		cacheAffinityId: "local-scope-secret",
		maxModelTurns: 1,
		observers: [(event) => { events.push({ type: event.type, data: event.data }); }],
	});
	assert.equal(result.verification.passed, true);
	assert.equal(requests.length, 1);
	assert.doesNotMatch(requests[0]!.body, /logical-session-secret|local-scope-secret/);
	assert.doesNotMatch(JSON.stringify([...requests[0]!.headers]), /logical-session-secret|local-scope-secret/);
	const requestBody = JSON.parse(requests[0]!.body) as { prompt_cache_key?: string };
	const expectedAffinity = deriveCacheAffinityId({
		scopeId: "local-scope-secret",
		providerId: "cache-test-provider",
		modelId: metadata.id,
		cachePrefixHash: result.capabilities.cachePrefixHash,
		toolBundleHash: result.capabilities.toolBundleHash,
		permissionProfileId: result.capabilities.permissionProfileId,
	});
	assert.equal(requestBody.prompt_cache_key, expectedAffinity.slice(0, 64));
	const observed = events.find(({ type, data }) => type === "context.prepared" && data.stage === "wire-observed");
	assert.ok(observed);
	assert.match(String(observed.data.wireRequestHash), /^[0-9a-f]{64}$/);
	assert.match(String(observed.data.affinityIdHash), /^[0-9a-f]{64}$/);
	assert.ok(Number(observed.data.stablePrefixBytes) <= Number(observed.data.wireBytes));
	const completed = events.find(({ type }) => type === "model.request.completed");
	assert.equal(completed?.data.cacheMissReason, "first-request");
	assert.equal(completed?.data.outputTokens, 3);
	assert.equal(completed?.data.visibleOutputTokens, 3);
	const trace = await readFile(result.tracePath, "utf8");
	assert.doesNotMatch(trace, /logical-session-secret|local-scope-secret/);
	assert.doesNotMatch(JSON.stringify(observed.data), /Return a short answer|provider.test/);
});

test("compact tool projections retain structured evidence fields", () => {
	const context = {
		systemPrompt: "system",
		tools: [],
		messages: [{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "run_test",
			content: [{ type: "text", text: "x".repeat(20_000) }],
			details: { testName: "suite name", sourceLocation: "src/example.test.ts:4", expected: "pass", actual: "fail", evidenceId: "evidence-1", secretField: "must not survive" },
		}],
	} as unknown as Parameters<typeof prepareRequest>[0];
	const prepared = prepareRequest(context, { contextWindow: 4_096, maxTokens: 512 }, 512);
	const projected = JSON.stringify(prepared.context.messages);
	assert.match(projected, /suite name|sourceLocation|evidence-1/);
	assert.match(projected, /expected|actual/);
	assert.doesNotMatch(projected, /secretField|must not survive/);
});
