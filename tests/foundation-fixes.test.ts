import assert from "node:assert/strict";
import test from "node:test";
import { compileTask } from "../packages/task-compiler/src/index.ts";
import { resolveCapabilities, buildStableSystemPrompt } from "../packages/capability-compiler/src/index.ts";
import { resolveToolCacheDefinitions } from "../packages/tools/src/index.ts";
import { prepareRequest, estimateRequestTokens } from "../packages/runtime/src/request-budget.ts";
const metadata = { id: "small", name: "Small", api: "openai-completions" as const, reasoning: false, input: ["text" as const], contextWindow: 8192, maxTokens: 1024, cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 } };

test("an 8K model admits the default coding tools with useful output capacity", () => {
 const capabilities = resolveCapabilities(compileTask({ objective: "Fix src/import.ts" }));
 const context: any = { systemPrompt: buildStableSystemPrompt(capabilities.preset, capabilities.toolIds), tools: resolveToolCacheDefinitions(capabilities.toolIds), messages: [{ role: "user", content: "Fix src/import.ts", timestamp: 1 }] };
 const prepared = prepareRequest(context, metadata, 1024);
 assert.equal(prepared.maxOutputTokens, 1024);
 assert.ok(prepared.inputTokens < 7168);
 assert.equal(estimateRequestTokens({ ...context, messages: [{ ...context.messages[0], details: "x".repeat(100_000) }] }), prepared.inputTokens);
 assert.throws(() => prepareRequest(context, metadata, 1024, undefined, () => NaN), /Invalid context/);
});

test("compacted tool results stay frozen when more context space becomes available", () => {
 const context: any = { messages: [{ role: "user", content: "Preserve the guard", timestamp: 1 }, { role: "toolResult", toolCallId: "read", toolName: "inspect_workspace", content: [{ type: "text", text: "evidence ".repeat(4000) }], isError: false, timestamp: 2 }] };
 const retained = new Map();
 const first = prepareRequest(context, metadata, 1024, retained);
 assert.equal(first.omittedResults, 1);
 const next = prepareRequest(context, { ...metadata, contextWindow: 128000 }, 1024, retained);
 assert.deepEqual(next.context.messages, first.context.messages);
 assert.equal(context.messages[1].content[0].text.length, 36000);
});
