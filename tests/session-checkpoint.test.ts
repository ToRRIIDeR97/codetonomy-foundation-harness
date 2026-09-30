import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { resumableCheckpointMessages } from "../packages/runtime/src/session-checkpoint.ts";

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });
const assistant = (content: unknown[], stopReason = "toolUse"): Message => ({
	role: "assistant", content, stopReason, api: "openai-completions", provider: "test", model: "test",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	timestamp: 1,
} as unknown as Message);
const call = (id: string) => ({ type: "toolCall", id, name: "inspect_workspace", arguments: { path: "a.txt" } });
const result = (id: string): Message => ({ role: "toolResult", toolCallId: id, toolName: "inspect_workspace", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1 } as Message);

test("checkpoint keeps completed exchanges and drops a call whose result never arrived", () => {
	const base = [user("Read a.txt")];
	const current = [...base, assistant([call("a")]), result("a"), assistant([{ type: "text", text: "next" }, call("b")])];
	const messages = resumableCheckpointMessages(base, current);
	assert.ok(messages);
	assert.equal(messages.length, 4);
	assert.deepEqual((messages[3] as { content: unknown[] }).content, [{ type: "text", text: "next" }]);
});

test("checkpoint drops an assistant message left with only unanswered calls", () => {
	const base = [user("Read a.txt")];
	const messages = resumableCheckpointMessages(base, [...base, assistant([call("a")])]);
	assert.deepEqual(messages, base);
});

test("checkpoint drops errored and aborted assistant turns after the prepared request", () => {
	const base = [user("Read a.txt")];
	const current = [...base, assistant([{ type: "text", text: "partial" }], "aborted"), assistant([{ type: "text", text: "boom" }], "error")];
	assert.deepEqual(resumableCheckpointMessages(base, current), base);
});

test("checkpoint copies messages instead of aliasing agent state", () => {
	const base = [user("Read a.txt")];
	const current = [...base, assistant([call("a")]), result("a")];
	const messages = resumableCheckpointMessages(base, current);
	assert.ok(messages);
	assert.notEqual(messages[1], current[1]);
	assert.deepEqual(messages, current);
});

test("checkpoint returns undefined without a prepared request when nothing valid remains", () => {
	assert.equal(resumableCheckpointMessages(undefined, [{ role: "user", content: "x" } as Message]), undefined);
	assert.deepEqual(resumableCheckpointMessages(undefined, []), []);
});
