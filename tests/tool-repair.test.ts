import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, symlink, unlink, readlink, link, chmod, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createHarness, type HarnessRunOptions } from "../packages/runtime/src/index.ts";
import { RunCheckpoint, rewindCheckpoint } from "../packages/runtime/src/checkpoint.ts";
import { CommandOutputStore, editWorkspaceTool, runWorkspaceCommandTool } from "../packages/tools/src/index.ts";
import type { HarnessEvent } from "../packages/contracts/src/index.ts";
import { skipWithoutSymlinks } from "./support/environment.ts";
import { tempDir, tempDirFactory } from "./support/temp.ts";

const temporary = tempDirFactory("tool-repair-");
type Call = { name: string; args: unknown; raw?: string };
function stream(calls: Call[], turn: number): Response {
	const base = { id: `response-${turn}`, object: "chat.completion.chunk", created: 1, model: "repair-model" };
	const delta = calls.length ? { role: "assistant", tool_calls: calls.map((call, index) => ({ index, id: `call-${turn}-${index}`, type: "function", function: { name: call.name, arguments: call.raw ?? JSON.stringify(call.args) } })) } : { role: "assistant", content: "Completed." };
	return new Response([
		{ ...base, choices: [{ index: 0, delta, finish_reason: null }] },
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }] },
	].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
async function run(root: string, objective: string, turns: Call[][], extra: Partial<HarnessRunOptions> = {}) {
	let requests = 0;
	const requestBodies: Array<{ messages: Array<{ content: unknown }> }> = [];
	const result = await createHarness().run({
		objective, workspaceRoot: root, traceDirectory: join(root, ".harness/runs"), permissionMode: "auto",
		provider: "repair-provider", modelId: "repair-model", maxModelTurns: 8,
		providerConfiguration: { id: "repair-provider", name: "Repair", kind: "openai-compatible", baseUrl: "https://repair.test/v1", apiKey: "test-key" },
		providerFetch: async (_input, init) => { requestBodies.push(JSON.parse(String(init?.body))); return stream(turns[requests] ?? [], ++requests); }, ...extra,
	});
	const events = (await readFile(result.tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as HarnessEvent);
	return { result, events, requests, requestBodies };
}

test("literal edit replacements preserve dollar patterns and reject ambiguous edits", async () => {
	const root = await temporary();
	for (const replacement of ["$", "$$", "$&", "$`", "$'", "$1", "$<name>"]) for (const replaceAll of [false, true]) {
		await writeFile(join(root, "text.txt"), "prefix old suffix");
		await editWorkspaceTool(root).execute("edit", { path: "text.txt", oldText: "old", newText: replacement, replaceAll });
		assert.equal(await readFile(join(root, "text.txt"), "utf8"), `prefix ${replacement} suffix`);
	}
	await writeFile(join(root, "text.txt"), "old old");
	await assert.rejects(editWorkspaceTool(root).execute("edit", { path: "text.txt", oldText: "old", newText: "new" }), (error: unknown) => {
		const details = (error as { details?: Record<string, unknown> }).details;
		return details?.resultKind === "failure" && details.mutationRisk === "none" && details.executionOutcome === "rejected-before-start";
	});
	assert.equal(await readFile(join(root, "text.txt"), "utf8"), "old old");
	await writeFile(join(root, "text.txt"), "old");
	await assert.rejects(editWorkspaceTool(root, { before: async () => {}, after: async () => { throw new Error("checkpoint failed"); } }).execute("settled", { path: "text.txt", oldText: "old", newText: "new" }), (error: unknown) => {
		const details = (error as { details?: Record<string, unknown> }).details;
		return details?.resultKind === "failure" && details.mutationRisk === "possible" && details.executionOutcome === "effects-unknown";
	});
	assert.equal(await readFile(join(root, "text.txt"), "utf8"), "new");
});

test("malformed final JSON never dispatches any JSON tool", async () => {
	for (const name of ["inspect_workspace", "write_workspace", "edit_workspace", "run_workspace_command"]) {
		for (const raw of ['{"path":"text.txt', '{"path":"text.txt"', '{"path":"text.txt"} garbage']) {
			const root = await temporary();
			await writeFile(join(root, "text.txt"), "original");
			const { events } = await run(root, "Update text.txt", [[{ name, args: null, raw }]], { maxModelTurns: 2 });
			assert.equal(events.filter(({ type }) => type === "tool.started").length, 0, name + raw);
			const failure = events.find(({ type, data }) => type === "tool.failed" && String(data.message).includes("Invalid final tool JSON"));
			assert.ok(failure);
			assert.equal(failure?.data.mutationRisk, "none");
			assert.equal(failure?.data.executionOutcome, "rejected-before-start");
			assert.equal(await readFile(join(root, "text.txt"), "utf8"), "original");
		}
	}
});

test("no-usage loops, batches and repeated failures have shared finite budgets", async () => {
	const root = await temporary();
	const reads = Array.from({ length: 10 }, () => [{ name: "list_workspace", args: { path: "." } }]);
	const loop = await run(root, "Inspect the repository", reads, { maxModelTurns: 3 });
	assert.equal(loop.requests, 3);
	const batch = await run(root, "Inspect the repository", [[...reads[0]!, ...reads[0]!, ...reads[0]!]], { maxToolCalls: 2 });
	assert.equal(batch.events.filter(({ type }) => type === "tool.started").length, 2);
	const failures = await run(root, "Read missing.txt", Array.from({ length: 10 }, () => [{ name: "inspect_workspace", args: { path: "missing.txt" } }]));
	assert.equal(failures.events.filter(({ type }) => type === "tool.started").length, 3);
	assert.ok(failures.requests <= 4);
});

test("abort settles pending approval and ignores a late grant", async () => {
	const root = await temporary();
	const controller = new AbortController();
	let grant!: (approved: boolean) => void;
	let requested!: () => void;
	const waiting = new Promise<void>((resolve) => { requested = resolve; });
	const running = run(root, "Write a.txt", [[{ name: "write_workspace", args: { path: "a.txt", content: "late" } }]], {
		permissionMode: "ask", signal: controller.signal,
		approve: () => { requested(); return new Promise((resolve) => { grant = resolve; }); },
	});
	await waiting;
	controller.abort();
	await assert.rejects(running, /aborted/i);
	grant(true);
	await assert.rejects(readFile(join(root, "a.txt")), { code: "ENOENT" });
});

test("checkpoints restore symlink metadata and oversized creations, report hard-link gaps", async (t) => {
	if (skipWithoutSymlinks(t)) return;
	const root = await temporary();
	const outside = await temporary();
	await writeFile(join(outside, "untouched"), "outside");
	await symlink(join(outside, "untouched"), join(root, "link"));
	const checkpoint = new RunCheckpoint(root, "links", join(root, ".harness/checkpoint.json"));
	await checkpoint.beforeWorkspace();
	await unlink(join(root, "link"));
	await writeFile(join(root, "link"), "replacement");
	await writeFile(join(root, "large.bin"), Buffer.alloc(3 * 1024 * 1024));
	await checkpoint.afterWorkspace();
	const result = await rewindCheckpoint(checkpoint.path!, root);
	assert.equal(result.coverage, "incomplete");
	assert.ok(result.residual?.includes("<command effects outside snapshot scope>"));
	assert.equal(await readlink(join(root, "link")), join(outside, "untouched"));
	assert.equal(await readFile(join(outside, "untouched"), "utf8"), "outside");
	await assert.rejects(readFile(join(root, "large.bin")), { code: "ENOENT" });
	await writeFile(join(root, "source"), "before");
	const hard = new RunCheckpoint(root, "hard", join(root, ".harness/hard.json"));
	await hard.beforeWorkspace();
	await link(join(root, "source"), join(root, "hard"));
	await hard.afterWorkspace();
	assert.equal(hard.coverage(), "incomplete");
	assert.equal((await rewindCheckpoint(hard.path!, root)).coverage, "incomplete");
});

test("command failure preserves mutation uncertainty and its primary error (fake adapter)", async () => {
	if (process.platform === "win32") return;
	const root = await temporary();
	const shim = join(root, "sandbox");
	await writeFile(shim, '#!/bin/sh\nprintf changed > count.txt\nwhile :; do printf xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done\n');
	await chmod(shim, 0o700);
	const tool = runWorkspaceCommandTool(root, { codexBinary: shim, outputStore: new CommandOutputStore({ workspaceRoot: root, outputDirectory: join(root, "command-output") }), observer: { before: async () => {}, after: async () => {}, beforeWorkspace: async () => {}, afterWorkspace: async () => { throw new Error("observer failed"); } } });
	await assert.rejects(tool.execute("command", { argv: ["ignored"], timeoutSeconds: 5 }), (error: unknown) => {
		assert.match(String(error), /output exceeds/);
		assert.equal((error as { details: { executionOutcome: string } }).details.executionOutcome, "effects-unknown");
		return true;
	});
	assert.equal(await readFile(join(root, "count.txt"), "utf8"), "changed");
});

test("deadline settles an approval wait and no-op writes do not verify a change", async () => {
	const root = await temporary();
	await writeFile(join(root, "a.txt"), "before");
	const noOp = await run(root, "Update a.txt", [
		[{ name: "inspect_workspace", args: { path: "a.txt" } }],
		[{ name: "write_workspace", args: { path: "a.txt", content: "before" } }],
	]);
	assert.equal(noOp.result.verification.passed, false);
	await assert.rejects(run(root, "Update a.txt", [[{ name: "write_workspace", args: { path: "a.txt", content: "late" } }]], {
		maxDurationMs: 200, permissionMode: "ask", approve: () => new Promise(() => {}),
	}), /deadline/i);
});

test("absence is evidence only for an explicit existence check", async () => {
	const root = await temporary();
	const { result, events } = await run(root, "Check whether missing.txt exists", [[{ name: "inspect_workspace", args: { path: "missing.txt" } }]]);
	assert.equal(result.verification.passed, true);
	const completed = events.find(({ type, data }) => type === "tool.completed" && data.toolId === "inspect_workspace");
	assert.equal(completed?.data.executionOutcome, "known");
	assert.equal(completed?.data.resultKind, "success");
	assert.equal(events.some(({ type }) => type === "tool.failed"), false);
	const read = await run(root, "Read missing.txt", [[{ name: "inspect_workspace", args: { path: "missing.txt" } }]]);
	assert.equal(read.result.verification.passed, false);
});

test("Anthropic and Responses finalize raw tool JSON strictly", async () => {
	for (const api of ["anthropic-messages", "openai-responses"] as const) for (const raw of ['{"path":"a.txt","content":"broken', '{"path":"a.txt","content":"broken"} trailing']) {
		const root = await temporary();
		let requests = 0;
		const recorded: HarnessEvent[] = [];
		const result = await createHarness().run({
			objective: "Write a.txt", workspaceRoot: root, traceDirectory: join(root, ".harness"), permissionMode: "auto", maxModelTurns: 2,
			provider: api === "anthropic-messages" ? "anthropic" : "openai", modelId: api === "anthropic-messages" ? "claude-haiku-4-5" : "gpt-5.4-mini",
			providerConfiguration: { id: api === "anthropic-messages" ? "anthropic" : "openai", kind: api === "anthropic-messages" ? "anthropic" : "openai", name: "Test", apiKey: "test-key" },
			observers: [(event) => { recorded.push(event); }],
			providerFetch: async () => {
				requests++;
				const item = { type: "function_call", id: `fc_${requests}`, call_id: `call_${requests}`, name: "write_workspace", arguments: raw };
				const events = api === "anthropic-messages" ? [
					{ type: "message_start", message: { id: `msg_${requests}`, usage: { input_tokens: 1, output_tokens: 0 } } },
					{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `call_${requests}`, name: "write_workspace", input: {} } },
					{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: raw } },
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
					{ type: "message_stop" },
				] : [
					{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
					{ type: "response.function_call_arguments.delta", output_index: 0, delta: raw },
					{ type: "response.output_item.done", output_index: 0, item },
					{ type: "response.completed", response: { id: `resp_${requests}`, status: "completed", output: [item] } },
				];
				return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
			},
		});
		assert.equal(result.verification.passed, false);
		assert.equal(recorded.filter(({ type }) => type === "tool.started").length, 0, api);
		assert.ok(recorded.some(({ type, data }) => type === "tool.failed" && String(data.message).includes("Invalid final tool JSON")), api);
		await assert.rejects(readFile(join(root, "a.txt")), { code: "ENOENT" });
	}
});

test("Pi custom raw-input calls and chunked JSON keep their declared contracts", async () => {
	const entry = new URL("../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.url);
	const { processResponsesStream } = await import(new URL("./api/openai-responses-shared.js", entry).href);
	const { AssistantMessageEventStream } = await import(new URL("./utils/event-stream.js", entry).href);
	for (const custom of [false, true]) {
		const raw = custom ? "not JSON: $&\n‘literal’" : '{"path":"a.txt"}';
		const item = custom ? { type: "custom_tool_call", id: "item", call_id: "call", name: "raw", input: raw } : { type: "function_call", id: "item", call_id: "call", name: "read", arguments: raw };
		const events = [
			{ type: "response.output_item.added", output_index: 0, item: custom ? { ...item, input: "" } : { ...item, arguments: "" } },
			...([raw.slice(0, 4), raw.slice(4)]).map((delta) => ({ type: custom ? "response.custom_tool_call_input.delta" : "response.function_call_arguments.delta", output_index: 0, delta })),
			{ type: "response.output_item.done", output_index: 0, item },
			{ type: "response.completed", response: { status: "completed", output: [item] } },
		];
		const output = { role: "assistant", content: [] as Array<{ arguments: unknown }>, stopReason: "pending", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		await processResponsesStream((async function* () { yield* events; })(), output, new AssistantMessageEventStream(), { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
		assert.deepEqual(output.content[0]?.arguments, custom ? { input: raw } : { path: "a.txt" });
		assert.equal(output.stopReason, "toolUse");
	}
});

test("uncertain commands cannot be replayed and Bash command evidence rejects masking (fake adapter)", async () => {
	if (process.platform === "win32") return;
	const root = await temporary();
	const shim = join(root, "sandbox");
	await writeFile(shim, '#!/bin/sh\nprintf x >> count.txt\nexit 1\n');
	await chmod(shim, 0o700);
	const previous = process.env.CODETONOMY_CODEX_BIN;
	process.env.CODETONOMY_CODEX_BIN = shim;
	try {
		const failed = await run(root, "Run npm test", [
			[{ name: "run_workspace_command", args: { argv: ["npm", "test"] } }],
			[{ name: "list_workspace", args: { path: "." } }],
			[{ name: "run_workspace_command", args: { argv: ["npm", "test"] } }],
		]);
		assert.equal(failed.result.verification.passed, false);
		assert.equal(await readFile(join(root, "count.txt"), "utf8"), "x");
		await writeFile(shim, '#!/bin/sh\nexit 0\n');
		for (const command of ["npm test", "npm test || true"]) {
			const { result } = await run(root, "Run npm test", [
				[{ name: "bash", args: { command: "ls" } }],
				[{ name: "bash", args: { command } }],
			], { toolInterface: "bash" });
			assert.equal(result.verification.passed, command === "npm test", command);
		}
	} finally {
		if (previous === undefined) delete process.env.CODETONOMY_CODEX_BIN;
		else process.env.CODETONOMY_CODEX_BIN = previous;
	}
});

test("an identical rewrite retains the original write evidence", async () => {
	const root = await temporary();
	await writeFile(join(root, "BRIEF.md"), "Build an app");
	const { result } = await run(root, "Read BRIEF.md. Write README.md.", [
		[{ name: "inspect_workspace", args: { path: "BRIEF.md" } }],
		[{ name: "write_workspace", args: { path: "README.md", content: "Usage" } }],
		[{ name: "write_workspace", args: { path: "README.md", content: "Usage" } }],
	]);
	assert.equal(result.verification.passed, true, JSON.stringify(result.verification));
});

test("content evidence survives metadata-only changes but rejects replaced bytes", async () => {
	for (const replaceContent of [false, true]) {
		const root = await temporary(), path = join(root, "source.txt");
		await writeFile(path, "before");
		let requests = 0;
		const { result } = await run(root, "Read source.txt", [], { maxModelTurns: 2, providerFetch: async () => {
			if (++requests === 1) return stream([{ name: "inspect_workspace", args: { path: "source.txt" } }], requests);
			const before = await stat(path);
			if (replaceContent) { await writeFile(path, "after!"); await utimes(path, before.atime, before.mtime); }
			else await chmod(path, before.mode & 0o777);
			return stream([], requests);
		} });
		assert.equal(result.verification.checks.find(c => c.id === "file-0")?.passed, !replaceContent, JSON.stringify(result.verification));
	}
});

test("a failed required test can be retried only after a fresh read and corrective edit", async () => {
	if (process.platform === "win32") return;
	const root = await temporary();
	await writeFile(join(root, "source.txt"), "broken");
	const shim = join(root, "sandbox");
	await writeFile(shim, '#!/bin/sh\nprintf x >> count.txt\nprintf diagnostic\n[ "$(cat source.txt)" = fixed ]\n');
	await chmod(shim, 0o700);
	const previous = process.env.CODETONOMY_CODEX_BIN;
	process.env.CODETONOMY_CODEX_BIN = shim;
	try {
		const { result, events, requestBodies } = await run(root, "Update source.txt. Run npm test", [
			[{ name: "inspect_workspace", args: { path: "source.txt" } }],
			[{ name: "run_workspace_command", args: { argv: ["npm", "test"] } }],
			[{ name: "edit_workspace", args: { path: "source.txt", oldText: "broken", newText: "fixed" } }],
			[{ name: "inspect_workspace", args: { path: "source.txt" } }],
			[{ name: "run_workspace_command", args: { argv: ["npm", "test"] } }],
			[{ name: "edit_workspace", args: { path: "source.txt", oldText: "broken", newText: "fixed" } }],
			[{ name: "run_workspace_command", args: { argv: ["npm", "test"] } }],
		], { maxModelTurns: 12 });
		assert.equal(result.verification.passed, true, JSON.stringify(result.verification));
		assert.equal(await readFile(join(root, "count.txt"), "utf8"), "xx");
		assert.equal(events.filter(e => e.type === "tool.failed" && String(e.data.message).includes("Previous mutation")).length, 2);
		const failure = events.find(e => e.type === "tool.failed" && e.data.toolId === "run_workspace_command")!;
		const prompt = JSON.stringify(requestBodies[2]);
		assert.match(prompt, /Next: inspect current files with inspect_workspace/);
		assert.match(prompt, /Make a corrective edit/);
		assert.ok(prompt.includes(JSON.stringify('run_workspace_command({"argv":["npm","test"],"cwd":"."})').slice(1, -1)));
		assert.equal(typeof failure.data.outputId, "string");
		assert.ok(prompt.includes(String(failure.data.outputId)));
	} finally {
		if (previous === undefined) delete process.env.CODETONOMY_CODEX_BIN;
		else process.env.CODETONOMY_CODEX_BIN = previous;
	}
});

test("a settled optional command cannot replay but can yield to required validation after a fresh read", async () => {
 if (process.platform === "win32") return;
 const root = await temporary();
 await writeFile(join(root, "BRIEF.md"), "Build the app.");
 await writeFile(join(root, "README.md"), "Old usage");
 const shim = join(root, "sandbox");
 await writeFile(shim, '#!/bin/sh\nif [ ! -e count.txt ]; then printf x > count.txt; exit 1; fi\nprintf x >> count.txt\n');
 await chmod(shim, 0o700);
 const previous = process.env.CODETONOMY_CODEX_BIN;
 process.env.CODETONOMY_CODEX_BIN = shim;
 try {
  const { result, events } = await run(root, "Read BRIEF.md. Write README.md. Run npm test.", [
   [{ name: "run_workspace_command", args: { argv: ["node", "missing-demo.mjs"] } }],
   [{ name: "run_workspace_command", args: { argv: ["npm", "test"] } }],
   [{ name: "write_workspace", args: { path: "README.md", content: "Usage" } }],
   [{ name: "inspect_workspace", args: { path: "BRIEF.md" } }],
   [{ name: "run_workspace_command", args: { argv: ["node", "missing-demo.mjs"] } }],
   [{ name: "run_workspace_command", args: { argv: ["npm", "test"] } }],
   [{ name: "write_workspace", args: { path: "README.md", content: "Usage" } }],
  ], { maxModelTurns: 12 });
  assert.equal(result.verification.passed, true, JSON.stringify(result.verification));
  assert.equal(await readFile(join(root, "count.txt"), "utf8"), "xx", "Only the first demo and the required validation executed");
  assert.equal(events.filter(e => e.type === "tool.failed" && String(e.data.message).includes("Previous mutation")).length, 3);
  assert.ok(events.some(e => e.type === "tool.failure.superseded" && String(e.data.reason).includes("not undone")));
 } finally {
  if (previous === undefined) delete process.env.CODETONOMY_CODEX_BIN;
  else process.env.CODETONOMY_CODEX_BIN = previous;
 }
});

test("missing receipts are actionable during execution and exhausted action output never claims success", async () => {
 const root = await temporary();
 await writeFile(join(root, "BRIEF.md"), "Build the app.");
 let requests = 0;
 const payloads: string[] = [];
 const { result } = await run(root, "Read BRIEF.md. Write README.md. Run npm test.", [], {
  maxModelTurns: 3,
  providerFetch: async (_input, init) => {
   payloads.push(String(init?.body));
   return stream(requests++ === 0 ? [{ name: "write_workspace", args: { path: "README.md", content: "Usage" } }] : [{ name: "inspect_workspace", args: { path: "README.md" } }], requests);
  },
 });
 assert.match(payloads[1]!, /Required evidence still missing/);
 // The structured interface names its own read tool, not bash-only advice.
 assert.match(payloads[1]!, /Read \\"BRIEF\.md\\" using inspect_workspace\./);
 assert.doesNotMatch(payloads[1]!, /standalone cat/);
 assert.match(payloads[1]!, /npm/);
 assert.match(payloads[2]!, /One model turn remains/);
 assert.equal(result.verification.passed, false);
 assert.doesNotMatch(result.output, /Completed the requested workspace task and verified/);
});

test("an interrupted command never gets the settled-command continuation exception", async () => {
 if (process.platform === "win32") return;
 const root = await temporary();
 await writeFile(join(root, "source.txt"), "before");
 const shim = join(root, "sandbox");
 await writeFile(shim, '#!/bin/sh\nprintf x >> count.txt\nwhile :; do printf xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done\n');
 await chmod(shim, 0o700);
 const previous = process.env.CODETONOMY_CODEX_BIN;
 process.env.CODETONOMY_CODEX_BIN = shim;
 try {
  const { result, events, requestBodies } = await run(root, "Update source.txt. Run npm test.", [
   [{ name: "run_workspace_command", args: { argv: ["node", "demo.mjs"], timeoutSeconds: 1 } }],
   [{ name: "inspect_workspace", args: { path: "source.txt" } }],
   [{ name: "edit_workspace", args: { path: "source.txt", oldText: "before", newText: "after" } }],
   [{ name: "run_workspace_command", args: { argv: ["npm", "test"] } }],
  ], { maxModelTurns: 6 });
  assert.equal(result.verification.passed, false);
  assert.equal(await readFile(join(root, "count.txt"), "utf8"), "x");
  assert.equal(await readFile(join(root, "source.txt"), "utf8"), "before");
  assert.equal(events.filter(e => e.type === "tool.failed" && String(e.data.message).includes("Previous mutation")).length, 2);
  assert.doesNotMatch(JSON.stringify(requestBodies[1]), /The command settled with a failure/);
 } finally {
  if (previous === undefined) delete process.env.CODETONOMY_CODEX_BIN;
  else process.env.CODETONOMY_CODEX_BIN = previous;
 }
});

test("recovery can create a confirmed absent target without pretending it was read", async () => {
 if (process.platform === "win32") return;
 for (const argv of [["node", "missing-demo.mjs"], ["npm", "test"]]) {
  const root = await temporary();
  const shim = join(root, "sandbox");
  await writeFile(shim, '#!/bin/sh\nprintf x >> count.txt\n[ -e source.txt ]\n');
  await chmod(shim, 0o700);
  const previous = process.env.CODETONOMY_CODEX_BIN;
  process.env.CODETONOMY_CODEX_BIN = shim;
  try {
   const { result } = await run(root, "Create source.txt. Run npm test.", [
    [{ name: "run_workspace_command", args: { argv } }],
    [{ name: "write_workspace", args: { path: "source.txt", content: "Created" } }],
    [{ name: "inspect_workspace", args: { path: "source.txt" } }],
    [{ name: "run_workspace_command", args: { argv: ["npm", "test"] } }],
   ]);
   assert.equal(result.verification.passed, true, JSON.stringify(result.verification));
   assert.equal(await readFile(join(root, "count.txt"), "utf8"), "xx");
  } finally {
   if (previous === undefined) delete process.env.CODETONOMY_CODEX_BIN;
   else process.env.CODETONOMY_CODEX_BIN = previous;
  }
 }
});

test("application verification is requested while repair turns remain", async () => {
 const root = await temporary();
 let requestedCheckpoint = false;
 let requests = 0;
 const { result } = await run(root, "Write status.txt", [], {
  maxModelTurns: 10,
  application: { id: "status", verify: async () => ({ passed: true, checks: [{ id: "status", passed: true, message: "Status exists" }] }) },
  providerFetch: async (_input, init) => {
   requests++;
   if (String(init?.body).includes("while repair turns remain")) { requestedCheckpoint = true; return stream([], requests); }
   return stream([{ name: requests === 1 ? "write_workspace" : "inspect_workspace", args: requests === 1 ? { path: "status.txt", content: "done" } : { path: "status.txt" } }], requests);
  },
 });
 assert.equal(requestedCheckpoint, true);
 assert.equal(requests, 7);
 assert.equal(result.verification.passed, true, JSON.stringify(result.verification));
});

test("external changes invalidate a trusted corrective-edit chain", async () => {
 if (process.platform === "win32") return;
 const root = await temporary();
 await writeFile(join(root, "source.txt"), "broken");
 const shim = join(root, "sandbox");
 await writeFile(shim, '#!/bin/sh\nprintf x >> count.txt\n[ "$(cat source.txt)" = ready ]\n');
 await chmod(shim, 0o700);
 const previous = process.env.CODETONOMY_CODEX_BIN;
 process.env.CODETONOMY_CODEX_BIN = shim;
 const turns: Call[][] = [
  [{ name: "run_workspace_command", args: { argv: ["npm", "test"] } }],
  [{ name: "inspect_workspace", args: { path: "source.txt" } }],
  [{ name: "edit_workspace", args: { path: "source.txt", oldText: "broken", newText: "fixed" } }],
  [{ name: "edit_workspace", args: { path: "source.txt", oldText: "external", newText: "ready" } }],
  [{ name: "inspect_workspace", args: { path: "source.txt" } }],
  [{ name: "edit_workspace", args: { path: "source.txt", oldText: "external", newText: "ready" } }],
  [{ name: "run_workspace_command", args: { argv: ["npm", "test"] } }],
 ];
 let requests = 0;
 try {
  const { result, events } = await run(root, "Update source.txt. Run npm test.", [], { maxModelTurns: 10, providerFetch: async () => {
   if (requests === 3) await writeFile(join(root, "source.txt"), "external");
   return stream(turns[requests] ?? [], ++requests);
  } });
  assert.equal(result.verification.passed, true, JSON.stringify(result.verification));
  assert.equal(await readFile(join(root, "count.txt"), "utf8"), "xx");
  assert.equal(events.filter(e => e.type === "tool.failed" && String(e.data.message).includes("Previous mutation")).length, 1);
 } finally {
  if (previous === undefined) delete process.env.CODETONOMY_CODEX_BIN;
  else process.env.CODETONOMY_CODEX_BIN = previous;
 }
});

test("a call rejected before it starts cannot fail a run whose required evidence is complete (#14)", async () => {
 const root = await temporary();
 await writeFile(join(root, "BRIEF.md"), "Build the app.");
 const { result, events } = await run(root, "Read BRIEF.md.", [
  [{ name: "read_tool_output", args: { outputId: "00000000-0000-4000-8000-000000000000", pattern: "x", contextLines: 50 } }],
  [{ name: "inspect_workspace", args: { path: "BRIEF.md" } }],
 ]);
 assert.ok(events.some(e => e.type === "tool.failed" && e.data.executionOutcome === "rejected-before-start"));
 assert.equal(result.verification.passed, true, JSON.stringify(result.verification.checks.filter(c => !c.passed)));
 assert.ok(events.some(e => e.type === "tool.failure.superseded" && e.data.reason === "Rejected before start; required evidence is complete"));
});

// The command outlives its 1s timeout briefly, then exits on its own (see #22 for Windows orphans).
const lingeringCommand = ["node", "-e", "setTimeout(() => {}, 4000)"];
// Inside the Windows sandbox npm cannot lstat the parents of a profile temp workspace; there, use the (ignored) checkout.
async function sandboxWorkspace(t: TestContext, prefix: string): Promise<string> {
 if (process.platform !== "win32") return tempDir(t, prefix);
 const root = await mkdtemp(join(process.cwd(), prefix));
 t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }));
 return root;
}

test("a timed-out sandboxed diagnostic can be followed by a fresh read, a fix and the required test (#14)", async (t) => {
 const root = await sandboxWorkspace(t, ".tool-repair-timeout-");
 await writeFile(join(root, "BRIEF.md"), "Build it.");
 await writeFile(join(root, "server.mjs"), "export const port = 1;\n");
 await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
 await writeFile(join(root, "a.test.mjs"), "import test from 'node:test'; test('ok', () => {});\n");
 const { result, events } = await run(root, "Read BRIEF.md. Update server.mjs. Run npm test.", [
  [{ name: "inspect_workspace", args: { path: "BRIEF.md" } }],
  [{ name: "run_workspace_command", args: { argv: lingeringCommand, timeoutSeconds: 1 } }],
  [{ name: "inspect_workspace", args: { path: "server.mjs" } }],
  [{ name: "edit_workspace", args: { path: "server.mjs", oldText: "port = 1", newText: "port = 2" } }],
  [{ name: "run_workspace_command", args: { argv: ["npm", "test"] } }],
 ]);
 // The complete workspace capture found no change, so the timeout's effects are known.
 const timedOut = events.find(e => e.type === "tool.failed" && /timed out/.test(String(e.data.message)));
 assert.equal(timedOut?.data.executionOutcome, "known");
 assert.ok(!events.some(e => e.type === "tool.failed" && String(e.data.message).startsWith("Previous mutation has unknown effects")), "fresh read then edit must not be blocked");
 assert.equal(await readFile(join(root, "server.mjs"), "utf8"), "export const port = 2;\n");
 assert.equal(result.verification.passed, true, JSON.stringify(result.verification.checks.filter(c => !c.passed)));
});

test("an unresolved timed-out command still fails the run (#14)", async () => {
 const root = await temporary();
 await writeFile(join(root, "BRIEF.md"), "Build it.");
 await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
 const { result } = await run(root, "Read BRIEF.md. Run npm test.", [
  [{ name: "inspect_workspace", args: { path: "BRIEF.md" } }],
  [{ name: "run_workspace_command", args: { argv: lingeringCommand, timeoutSeconds: 1 } }],
 ], { maxModelTurns: 3 });
 assert.equal(result.verification.passed, false);
 assert.match(result.verification.checks.find(c => c.id === "runtime-complete")?.message ?? "", /timed out/);
});

test("a timed-out command that changed the workspace keeps unknown effects and blocks continuation (#14)", async (t) => {
 const root = await sandboxWorkspace(t, ".tool-repair-interrupted-");
 await writeFile(join(root, "source.txt"), "before");
 await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
 const { result, events } = await run(root, "Update source.txt. Run npm test.", [
  [{ name: "run_workspace_command", args: { argv: ["node", "-e", "require('node:fs').writeFileSync('partial.txt', 'x'); setTimeout(() => {}, 4000)"], timeoutSeconds: 1 } }],
  [{ name: "inspect_workspace", args: { path: "source.txt" } }],
  [{ name: "edit_workspace", args: { path: "source.txt", oldText: "before", newText: "after" } }],
 ], { maxModelTurns: 4 });
 assert.ok(events.some(e => e.type === "tool.failed" && e.data.executionOutcome === "effects-unknown"));
 assert.equal(await readFile(join(root, "source.txt"), "utf8"), "before");
 assert.ok(events.some(e => e.type === "tool.failed" && String(e.data.message).startsWith("Previous mutation has unknown effects")));
 assert.equal(result.verification.passed, false);
});
