import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateConversationTranscript, type ConversationTranscript, type RunRecoveryState } from "../packages/contracts/src/index.ts";
import { prepareRequest, estimateRequestTokens } from "../packages/runtime/src/request-budget.ts";
import { createHarness } from "../packages/runtime/src/index.ts";
const model = { id: "small", name: "Small", api: "openai-completions" as const, reasoning: false, input: ["text" as const], contextWindow: 1_000_000, maxTokens: 8192, cost: { input: 1, output: 1, cacheRead: .1, cacheWrite: 1 } };
const usage = { input: 100, output: 10, cacheRead: 900, cacheWrite: 0, totalTokens: 1010, cost: { input: .0001, output: .00001, cacheRead: .00009, cacheWrite: 0, total: .0002 } };
const assistant = (content: any[], timestamp: number) => ({ role: "assistant", content, api: "openai-completions", provider: "test", model: "small", usage, stopReason: "toolUse", timestamp });
/** One assistant message carrying several tool calls, as a provider would stream them. */
const batchResponse = (calls: Array<{ name: string; arguments: object }>) => new Response([
 { id: "reply", object: "chat.completion.chunk", created: 1, model: "small", choices: [{ index: 0, delta: { role: "assistant", tool_calls: calls.map((call, index) => ({ index, id: `call-${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }, finish_reason: null }] },
 { id: "reply", object: "chat.completion.chunk", created: 1, model: "small", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 900 }, completion_tokens: 10, total_tokens: 1010 } },
].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });

test("cost retention compacts old writes and results once, preserving instructions, decisions and protocol", () => {
 const messages: any[] = [{ role: "user", content: "Never edit guard.txt", timestamp: 1 }];
 for (let i = 0; i < 12; i++) {
  messages.push(assistant([{ type: "text", text: `Decision ${i}: keep the public API.` }, { type: "toolCall", id: `write-${i}`, name: "write_workspace", arguments: { path: `src/${i}.js`, content: `// module ${i}\n` + "x".repeat(22000) } }], i * 2 + 2));
  messages.push({ role: "toolResult", toolCallId: `write-${i}`, toolName: "write_workspace", content: [{ type: "text", text: "Written" }], details: { path: `src/${i}.js` }, timestamp: i * 2 + 3, isError: false });
 }
 const context: any = { systemPrompt: "Mandatory policy", messages };
 const retained = new Map();
 const defaultPrepared = prepareRequest(context, model, 8192);
 assert.equal(defaultPrepared.retentionTokens, 262_144);
 assert.equal(defaultPrepared.compactedArguments, 0);
 const prepared = prepareRequest(context, model, 8192, retained, undefined, 65_536);
 assert.ok(estimateRequestTokens(context) > 65536);
 assert.ok(prepared.inputTokens < 49152);
 assert.ok(prepared.compactedArguments > 0);
 assert.equal(prepared.maxOutputTokens, 8192);
 assert.deepEqual(prepared.context.messages[0], messages[0]);
 assert.deepEqual(prepared.context.messages.at(-2), messages.at(-2));
 for (let i = 0; i < 12; i++) assert.match(JSON.stringify(prepared.context), new RegExp(`Decision ${i}: keep the public API`));
 assert.match(JSON.stringify(prepared.context), /Historical content omitted/);
 validateConversationTranscript({ version: 1, messages: prepared.context.messages });
 const followup = prepareRequest({ ...context, messages: [...messages, { role: "user", content: "Continue", timestamp: 30 }] }, model, 8192, retained, undefined, 65_536);
 assert.deepEqual(followup.context.messages.slice(0, messages.length), prepared.context.messages);
 const resumed = prepareRequest(prepared.context, model, 8192, undefined, undefined, 65_536);
 assert.deepEqual(resumed.context, prepared.context);
 const mandatory: any = { messages: [{ role: "user", content: "required ".repeat(30_000), timestamp: 1 }] };
 assert.equal(prepareRequest(mandatory, model, 8192, undefined, undefined, 65_536).retentionExceeded, true);
 const withEvidence: any = { messages: [...mandatory.messages,
  assistant([{ type: "toolCall", id: "evidence", name: "inspect_workspace", arguments: { path: "evidence.txt" } }], 2),
  { role: "toolResult", toolCallId: "evidence", toolName: "inspect_workspace", content: [{ type: "text", text: "evidence ".repeat(4000) }], details: { path: "evidence.txt", sourceHash: "a".repeat(64) }, isError: false, timestamp: 3 }, ...messages] };
 const over = prepareRequest(withEvidence, model, 8192, undefined, undefined, 65_536);
 assert.equal(over.retentionExceeded, true);
 assert.deepEqual(prepareRequest(over.context, model, 8192, undefined, undefined, 65_536).context, over.context);
 assert.match(JSON.stringify(over.context.messages[2]), /evidence.txt/);
 assert.throws(() => prepareRequest(mandatory, { ...model, contextWindow: 8192 }, 1024), /exceeds model context/);
 assert.throws(() => prepareRequest(context, model, 8192, undefined, undefined, 0), /retention/);
});

test("an interrupted multi-call batch preserves completed tool exchanges without inventing results", async t => {
 const root = await mkdtemp(join(tmpdir(), "session-multicall-"));
 t.after(() => rm(root, { recursive: true, force: true }));
 const controller = new AbortController();
 let transcript: ConversationTranscript | undefined;
 let recovery: RunRecoveryState | undefined;
 let writeStarts = 0;
 let batchRequests = 0;
 await assert.rejects(createHarness().run({
  objective: "Persist both draft notes",
  workspaceRoot: root,
  traceDirectory: join(root, "runs"),
  provider: "test",
  modelId: "small",
  maxOutputTokens: 256,
  maxModelTurns: 4,
  providerRetryLimit: 0,
  permissionMode: "auto",
  providerConfiguration: { id: "test", name: "Test", kind: "openai-compatible" as const, baseUrl: "https://test.invalid/v1", modelMetadata: model },
  signal: controller.signal,
  onTranscript: value => { transcript = value; },
  onRecovery: value => { recovery = value; },
  observers: [(event: any) => {
   if (event.type === "tool.started" && event.data.toolId === "write_workspace") writeStarts++;
   // Interruption lands between the first completed result and the second call.
   if (event.type === "tool.completed" && event.data.toolId === "write_workspace") controller.abort();
  }],
  providerFetch: async () => {
   batchRequests++;
   return batchResponse([
    { name: "write_workspace", arguments: { path: "a.txt", content: "first result committed" } },
    { name: "write_workspace", arguments: { path: "b.txt", content: "never ran" } },
   ]);
  },
 }), /aborted/i);
 assert.equal(batchRequests, 1);
 assert.equal(writeStarts, 1, "the second call must never start after the interruption");
 assert.equal(await readFile(join(root, "a.txt"), "utf8"), "first result committed");
 await assert.rejects(readFile(join(root, "b.txt")), { code: "ENOENT" });
 validateConversationTranscript(transcript);
 const messages = transcript!.messages;
 const assistantMessage = messages.find((message: any) => message.role === "assistant") as any;
 assert.equal(assistantMessage.content.filter((block: any) => block.type === "toolCall").length, 1, "only the call with a completed result stays paired");
 assert.ok(messages.some((message: any) => message.role === "toolResult" && JSON.stringify(message).includes("a.txt")), "the completed write exchange must survive the checkpoint");
 const serialized = JSON.stringify(messages);
 assert.match(serialized, /first result committed/);
 assert.doesNotMatch(serialized, /b\.txt/, "a call without a result is dropped, never paired with an invented success");
 // The dropped call never dispatched, so it is known not-started rather than unknown.
 assert.ok(recovery, "the interrupted run must publish recovery state");
 assert.equal(recovery!.uncertainMutations.length, 0);
});
