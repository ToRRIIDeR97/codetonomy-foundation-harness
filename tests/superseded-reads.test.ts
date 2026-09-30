import assert from "node:assert/strict";
import test from "node:test";
import { prepareRequest, supersededReadIndexes } from "../packages/runtime/src/request-budget.ts";

const call = (id: string, name: string, args: Record<string, unknown>, timestamp: number): any => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name, arguments: args }],
	api: "openai-completions",
	provider: "test",
	model: "test",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "toolUse",
	timestamp,
});
const result = (id: string, toolName: string, text: string, details: Record<string, unknown>, timestamp: number, isError = false): any =>
	({ role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text }], details, isError, timestamp });
const inspect = (id: string, path: string, text: string, timestamp: number, range: { offset?: number; limit?: number } = {}): any[] => [
	call(id, "inspect_workspace", { path, ...range }, timestamp),
	result(id, "inspect_workspace", text, { path, offset: range.offset ?? 1, limit: range.limit ?? 400, sourceHash: "a".repeat(64) }, timestamp + 1),
];
const bashRead = (id: string, argv: string[], path: string, timestamp: number, cwd = "."): any[] => [
	call(id, "bash", { command: argv.join(" ") }, timestamp),
	result(id, "bash", "content", { cwd, semanticOperationId: "inspect_workspace", semanticArgv: argv, paths: [path], resultKind: "success" }, timestamp + 1),
];
const write = (id: string, path: string, timestamp: number, isError = false): any[] => [
	call(id, "write_workspace", { path, content: "fixed" }, timestamp),
	result(id, "write_workspace", "Written", { path, bytes: 5, changed: true }, timestamp + 1, isError),
];

test("reads are superseded by an identical later read or a later write to the same path", () => {
	const messages = [
		{ role: "user", content: "Fix the app", timestamp: 0 },
		...inspect("a1", "src/app.js", "old app", 1),          // 2: superseded by a2
		...inspect("b1", "notes.md", "lines 1-400", 3),        // 4: different range from b2, stays
		...inspect("c1", "./lib/util.js", "old util", 5),      // 6: superseded by the write
		...bashRead("d1", ["cat", "README.md"], "README.md", 7), // 8: superseded by d2
		...bashRead("e1", ["cat", "a.txt"], "a.txt", 9, "sub"),  // 10: cwd is not the root, ignored
		...inspect("f1", "g.txt", "g", 11),                    // 12: the later write failed, stays
		...inspect("a2", "src/app.js", "new app", 13),
		...inspect("b2", "notes.md", "lines 400-800", 15, { offset: 400 }),
		...write("w1", "lib/util.js", 17),
		...bashRead("d2", ["cat", "README.md"], "README.md", 19),
		...bashRead("e2", ["cat", "a.txt"], "a.txt", 21, "sub"),
		...write("w2", "g.txt", 23, true),
	];
	assert.deepEqual(supersededReadIndexes(messages as any), [2, 6, 8]);
});

test("under retention, stale reads are compacted before older reads that are still current", () => {
	const messages = [
		{ role: "user", content: "Implement the spec", timestamp: 0 },
		...inspect("spec", "SPEC.md", "s".repeat(60_000), 1),
		...inspect("app-old", "src/app.js", "o".repeat(90_000), 3),
		...write("app-write", "src/app.js", 5),
		...inspect("recent", "other.txt", "r".repeat(60_000), 7),
	];
	const model = { contextWindow: 200_000, maxTokens: 8_192 };
	const prepared = prepareRequest({ systemPrompt: "Policy", messages } as any, model, 8_192, undefined, undefined, 65_536);
	assert.equal(prepared.retentionExceeded, false);
	assert.equal(prepared.supersededResults, 1);
	assert.equal(prepared.omittedResults, 1);
	const text = (index: number) => JSON.stringify(prepared.context.messages[index]);
	assert.match(text(4), /Earlier inspect_workspace result compacted/);
	assert.match(text(4), /reread the path after any file change/);
	assert.equal(prepared.context.messages[2], messages[2], "the current spec read is untouched");
	assert.equal(prepared.context.messages.at(-1), messages.at(-1), "the recent window is untouched");
	// Compacted results stay frozen for later requests.
	assert.deepEqual(prepareRequest(prepared.context, model, 8_192, undefined, undefined, 65_536).context, prepared.context);
});

test("no compaction happens below the retention threshold, even for stale reads", () => {
	const messages = [
		{ role: "user", content: "Fix it", timestamp: 0 },
		...inspect("a1", "src/app.js", "old", 1),
		...inspect("a2", "src/app.js", "new", 3),
	];
	const prepared = prepareRequest({ systemPrompt: "Policy", messages } as any, { contextWindow: 200_000, maxTokens: 8_192 }, 8_192);
	assert.equal(prepared.supersededResults, 0);
	assert.deepEqual(prepared.context.messages, messages);
});
