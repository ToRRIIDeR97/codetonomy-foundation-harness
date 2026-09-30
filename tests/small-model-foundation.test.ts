import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { createHarness, type HarnessModelMetadata, type HarnessRunOptions } from "../packages/runtime/src/index.ts";
import { assertRequestAdmission, createRequestAccounting, prepareRequest, requestReservation, reserveRequest, reserveRequests, reserveWireRequest, settleRequest, type RunSpendBudgetState } from "../packages/runtime/src/request-budget.ts";
import { compileTask } from "../packages/task-compiler/src/index.ts";
import { resolveCapabilities } from "../packages/capability-compiler/src/index.ts";
import { compileContext, renderContextTail } from "../packages/context-compiler/src/index.ts";
import { inspectWorkspaceTool, searchWorkspaceTool } from "../packages/tools/src/index.ts";
import { tempDir, tempDirFactory } from "./support/temp.ts";

const profile: HarnessModelMetadata = { id: "small", name: "Small local model", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }, cacheStrategy: "NO_PROVIDER_CACHE", thinkingFormat: "qwen" };
function response(text: string, call?: { name: string; arguments: unknown }): Response {
	const base = { id: "small-response", object: "chat.completion.chunk", created: 1, model: "small" };
	const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: "write-call", type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { role: "assistant", content: text };
	return new Response([
		{ ...base, choices: [{ index: 0, delta, finish_reason: null }] },
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
	].map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
const temporary = tempDirFactory("small-foundation-");
async function run(options: Partial<HarnessRunOptions>, fetcher: typeof fetch) {
	const root = await temporary();
	return createHarness().run({ objective: "Return a short answer", workspaceRoot: root, traceDirectory: join(root, ".harness/runs"), permissionMode: "auto", toolSelection: "minimal", provider: "local", modelId: "small", providerConfiguration: { id: "local", name: "Local", kind: "openai-compatible", baseUrl: "http://localhost:1234/v1", modelMetadata: { ...profile, contextWindow: 32_768 } }, maxModelTurns: 2, maxOutputTokens: 256, providerRetryLimit: 0, providerFetch: fetcher, ...options });
}

test("literal file content is not parsed as another target and application criteria cannot shadow built-ins", () => {
	const task = compileTask({ objective: 'Write a.txt containing exactly "file.txt"' });
	assert.equal(task.acceptanceCriteria.filter(c => c.target).length, 1);
	assert.equal(task.acceptanceCriteria.find(c => c.target)?.expectedContent, "file.txt");
	assert.throws(() => compileTask({ objective: "Answer", acceptanceCriteria: [{ id: "non-empty-output", description: "Shadow the checker", required: true }] }), /Duplicate/);
	assert.throws(() => resolveCapabilities(compileTask({ objective: "Update a.txt" }), undefined, [], [], { toolCeiling: [] }), /cannot satisfy/);
});

test("file obligations stay bound to their explicit actions", () => {
	const actions = (objective: string) => compileTask({ objective, workspaceRoot: "/workspace" }).acceptanceCriteria
		.filter((criterion) => criterion.action && criterion.target)
		.map(({ action, target }) => [action, relative(resolve("/workspace"), target!)]);
	assert.deepEqual(actions("Read BRIEF.md, implement its requirements, write README.md and automated tests, and run npm test."), [
		["read", "BRIEF.md"], ["write", "README.md"],
	]);
	assert.deepEqual(actions("read A.md and B.md, then write C.md"), [["read", "A.md"], ["read", "B.md"], ["write", "C.md"]]);
	assert.deepEqual(actions("Do not write A.md, read B.md, write C.md"), [["read", "B.md"], ["write", "C.md"]]);
	assert.deepEqual(compileTask({ objective: "Do not write A.md, read B.md, write C.md", workspaceRoot: "/workspace" }).prohibitions, [{ action: "write", target: resolve("/workspace/A.md") }]);
	assert.deepEqual(actions("Delete A.md. Remove B.md."), [["delete", "A.md"], ["delete", "B.md"]]);
	assert.deepEqual(actions("Create a presentation output/installed-review.pptx"), [["write", join("output", "installed-review.pptx")]]);
	assert.deepEqual(actions("Read src/update.ts and docs/read-guide.md"), [["read", join("src", "update.ts")], ["read", join("docs", "read-guide.md")]]);
	assert.deepEqual(compileTask({ objective: "Do not delete A.md", workspaceRoot: "/workspace" }).prohibitions, [{ action: "write", target: resolve("/workspace/A.md") }]);
	assert.deepEqual(actions("Write A.md if needed"), []);
});

test("reference files and abbreviated sibling paths do not become false file obligations", () => {
	const actions = (objective: string) => compileTask({ objective, workspaceRoot: "/workspace" }).acceptanceCriteria
		.filter((criterion) => criterion.action && criterion.target)
		.map(({ action, target }) => [action, relative(resolve("/workspace"), target!)]);
	for (const reference of ["from", "using", "per", "according to", "based on", "as described in", "specified in"]) {
		assert.deepEqual(actions(`Implement history.mjs ${reference} specs/extensions.md`), [["write", "history.mjs"]], reference);
	}
	assert.deepEqual(actions("Add tests for model.mjs"), []);
	assert.deepEqual(actions("Write a.ts and b.ts using spec.md; read spec.md"), [["write", "a.ts"], ["write", "b.ts"], ["read", "spec.md"]]);
	assert.deepEqual(actions("Read specs/a.md and b.md"), [["read", join("specs", "a.md")]]);
	assert.deepEqual(actions("Read specs/a.md and ./b.md"), [["read", join("specs", "a.md")], ["read", "b.md"]]);
	assert.deepEqual(actions("Fix the bug in src/model.ts"), [["write", join("src", "model.ts")]]);
	assert.deepEqual(compileTask({ objective: "Do not write src/a.ts or b.ts", workspaceRoot: "/workspace" }).prohibitions, [
		{ action: "write", target: resolve("/workspace/src/a.ts") }, { action: "write", target: resolve("/workspace/b.ts") },
	]);
});

test("implementing a module from a specification completes without editing the specification", async (t) => {
	const root = await tempDir(t, "foundation-reference-");
	await mkdir(join(root, "specs"));
	await writeFile(join(root, "specs/extensions.md"), "Export an empty history array. Preserve this specification.\n");
	const calls = [
		{ name: "list_workspace", arguments: {} },
		{ name: "inspect_workspace", arguments: { path: "specs/extensions.md" } },
		{ name: "write_workspace", arguments: { path: "history.mjs", content: "export const history = [];\n" } },
	];
	let requests = 0;
	const evidenceGuidance: string[] = [];
	const result = await run({ objective: "Read specs/extensions.md, then implement history.mjs from specs/extensions.md. Preserve the specification.", workspaceRoot: root, traceDirectory: join(root, ".harness"), maxModelTurns: 5 }, async (_input, init) => {
		const body = JSON.parse(String(init?.body));
		for (const message of body.messages) if (message.role === "user" && JSON.stringify(message).includes("Required evidence still missing")) evidenceGuidance.push(JSON.stringify(message));
		const next = response("Implemented history.mjs and preserved the specification.", calls[requests]);
		return new Response((await next.text()).replaceAll("write-call", `call-${++requests}`), { headers: { "content-type": "text/event-stream" } });
	});
	assert.equal(result.verification.passed, true, JSON.stringify(result.verification));
	assert.equal(requests, 4);
	assert.ok(evidenceGuidance.some((text) => text.includes("using inspect_workspace")));
	assert.ok(evidenceGuidance.every((text) => !text.includes("standalone cat")));
	assert.equal(await readFile(join(root, "specs/extensions.md"), "utf8"), "Export an empty history array. Preserve this specification.\n");
});

test("verification retries preserve the full previous provider message prefix", async (t) => {
	const root = await tempDir(t, "foundation-retry-prefix-");
	await writeFile(join(root, "a.txt"), "Alpha");
	await writeFile(join(root, "b.txt"), "Beta");
	const calls = [
		{ name: "inspect_workspace", arguments: { path: "a.txt" } },
		undefined, // A premature final answer forces the normal verifier-repair loop.
		{ name: "inspect_workspace", arguments: { path: "b.txt" } },
		{ name: "write_workspace", arguments: { path: "result.txt", content: "Alpha Beta" } },
	];
	const requests: Array<{ messages: unknown[] }> = [];
	const result = await run({ objective: "Read a.txt and b.txt, then write result.txt.", workspaceRoot: root, traceDirectory: join(root, ".harness"), maxModelTurns: 7 }, async (_input, init) => {
		requests.push(JSON.parse(String(init?.body)));
		const next = response("Done.", calls[requests.length - 1]);
		return new Response((await next.text()).replaceAll("write-call", `call-${requests.length}`), { headers: { "content-type": "text/event-stream" } });
	});
	assert.equal(result.verification.passed, true, JSON.stringify(result.verification));
	assert.equal(requests.length, 5);
	assert.ok(JSON.stringify(requests[2]).includes("verification-feedback"));
	for (let i = 1; i < requests.length; i++) {
		assert.deepEqual(requests[i]!.messages.slice(0, requests[i - 1]!.messages.length), requests[i - 1]!.messages, `request ${i + 1} must retain request ${i}'s prefix`);
	}
	assert.equal(await readFile(join(root, "result.txt"), "utf8"), "Alpha Beta");
});

test("partial usage from an interrupted request retains the reservation", () => {
	const state: RunSpendBudgetState = { costUsd: 0, totalTokens: 0, maxCostUsd: 1 };
	const reservation = reserveRequest(state, 1000, 500, profile.cost);
	settleRequest(state, reservation, { totalTokens: 100, cost: { total: 0.0001 } }, false);
	assert.equal(state.reservedCostUsd, reservation.costUsd);
	assert.equal(state.costUsd, 0.0001);
});

test("wire admission reserves SDK reasoning expansion before transmission", () => {
	const state: RunSpendBudgetState = { maxCostUsd: 0.004, costUsd: 0, totalTokens: 0 };
	const reservation = reserveRequest(state, 1500, 256, profile.cost);
	assert.throws(() => reserveWireRequest(state, reservation, 1500, 256, JSON.stringify({ max_tokens: 2048 }), { ...profile, maxTokens: 4096 }), /cost ceiling/);
	assert.equal(state.reservedCostUsd, reservation.costUsd);
	const admitted = reserveWireRequest(state, reservation, 1500, 256, JSON.stringify({ max_tokens: 512 }), profile);
	assert.ok(admitted.costUsd > reservation.costUsd);
	settleRequest(state, admitted, { totalTokens: 100, cost: { total: 0.0001 } });
	assert.equal(state.reservedCostUsd, 0);
	const heldState: RunSpendBudgetState = { costUsd: 0, totalTokens: 0 };
	const held = reserveRequest(heldState, 1500, 256, profile.cost);
	const grown = reserveWireRequest(heldState, held, 1500, 512, JSON.stringify({ max_tokens: 512 }), profile);
	assert.equal(grown.outputTokens, 512);
});

test("an Anthropic-compatible SDK cannot spend an unreserved reasoning expansion", async () => {
	let requests = 0;
	const result = await run({ maxCostUsd: 0.004, reasoningLevel: "low", providerConfiguration: { id: "local", name: "Local", kind: "anthropic-compatible", apiKey: "test-key", baseUrl: "http://localhost:1234", modelMetadata: { ...profile, api: "anthropic-messages", reasoning: true, maxTokens: 4096 } } }, async () => { requests++; throw new Error("No request should be transmitted"); });
	assert.equal(requests, 0);
	assert.equal(result.verification.passed, false);
	assert.match(result.verification.checks.map(check => check.message).join("\n"), /Aggregate cost ceiling/);
});

test("rendered context budgets include wrappers and metadata, regardless of backend estimates", async () => {
	const memory = { recall: async () => ({ taskId: "unused", agentPresetId: "unused", structuralContext: [], evidence: [{ content: "short", metadata: "x".repeat(8000) }], memories: [], sourceVersions: ["v1"], provenance: [{ details: "x".repeat(5000) }], estimatedTokens: 1, tokenBudget: 150, contextHash: "ignored" }), capture: async () => {} };
	const packet = await compileContext({ taskId: "t", agentPresetId: "p", query: "q", tokenBudget: 150, recall: memory.recall });
	assert.ok(Math.ceil(Buffer.byteLength(renderContextTail(packet)) / 3) <= 150);
	assert.equal(packet.evidence.length, 0);
	assert.equal(packet.provenance.length, 0);
});

test("request projection keeps user constraints, recent results, errors and call identities", () => {
	const call = { role: "assistant", content: [{ type: "toolCall", id: "old", name: "inspect_workspace", arguments: { path: "a.txt" } }], api: "openai-completions", provider: "local", model: "small", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 1 } as const;
	const commandCall = { ...call, content: [{ type: "toolCall", id: "command", name: "run_workspace_command", arguments: { argv: ["test"] } }], timestamp: 3 } as const;
	const outputId = "12345678-1234-4123-8123-123456789abc";
	const longPath = `${"nested/".repeat(90)}a.txt`;
	const context: any = { systemPrompt: "Never modify guard.txt", tools: [], messages: [
		{ role: "user", content: "Keep the original constraints", timestamp: 0 },
		call,
		{ role: "toolResult", toolCallId: "old", toolName: "inspect_workspace", content: [{ type: "text", text: "x".repeat(45_000) }], details: { path: longPath, offset: 1, limit: 2000, sourceHash: "a".repeat(64), privateField: "must disappear" }, isError: false, timestamp: 2 },
		{ role: "toolResult", toolCallId: "indexed", toolName: "search_workspace", content: [{ type: "text", text: "indexed excerpt ".repeat(3_000) }], details: { backend: "memoryDB", sourceRefs: [{ path: "source.ts", sourceHash: "b".repeat(64) }], claimCandidates: [{ private: "drop" }] }, isError: false, timestamp: 3 },
		commandCall,
		{ role: "toolResult", toolCallId: "command", toolName: "run_workspace_command", content: [{ type: "text", text: "y".repeat(45_000) }], details: { resultKind: "success", mutationRisk: "possible", exitCode: 0, outputId, paths: [longPath], capturedBytes: 15_000, outputComplete: true }, isError: false, timestamp: 4 },
		{ role: "toolResult", toolCallId: "error", toolName: "inspect_workspace", content: [{ type: "text", text: "No such file" }], isError: true, timestamp: 5 },
		{ role: "user", content: "Continue", timestamp: 6 },
	] };
	const before = JSON.stringify(context);
	const projectionProfile = { ...profile, contextWindow: 12_288 };
	const prepared = prepareRequest(context, projectionProfile, 1024);
	assert.equal(prepared.omittedResults, 3);
	const projected = JSON.stringify(prepared.context);
	assert.match(projected, /Keep the original constraints/);
	assert.match(projected, /No such file/);
	assert.ok(projected.includes(longPath));
	assert.match(projected, /source\.ts/);
	assert.match(projected, new RegExp("b".repeat(64)));
	assert.match(projected, /historical source evidence; reread the path/);
	assert.match(projected, new RegExp(outputId));
	assert.match(projected, /read_tool_output/);
	assert.match(projected, /do not rerun the command/);
	assert.doesNotMatch(projected, /must disappear|claimCandidates|privateField/);
	assert.equal((prepared.context.messages[2] as { toolCallId?: string } | undefined)?.toolCallId, "old");
	assert.equal(JSON.stringify(context), before);
	assert.throws(() => prepareRequest({ ...context, systemPrompt: "mandatory ".repeat(10_000) }, projectionProfile, 1024), /exceeds model context/);
});

test("request projection compacts the latest failed command without losing recovery metadata", () => {
	const outputId = "12345678-1234-4123-8123-123456789abc";
	const context: any = { systemPrompt: "Repair the failed command", tools: [], messages: [
		{ role: "user", content: "Run the check", timestamp: 0 },
		{ role: "assistant", content: [{ type: "toolCall", id: "failed", name: "run_workspace_command", arguments: { argv: ["check"] } }], api: "openai-completions", provider: "local", model: "small", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 1 },
		{ role: "toolResult", toolCallId: "failed", toolName: "run_workspace_command", content: [{ type: "text", text: `failure evidence\nExcerpt:\nkeep error evidence\n${"failure evidence ".repeat(3_000)}` }], details: { resultKind: "failure", mutationRisk: "none", outputId, private: "drop" }, isError: true, timestamp: 2 },
	] };
	const prepared = prepareRequest(context, { ...profile, contextWindow: 4_096 }, 1_024);
	assert.equal(prepared.omittedResults, 1);
	const projected = JSON.stringify(prepared.context);
	assert.match(projected, /failure evidence/);
	assert.match(projected, new RegExp(outputId));
	assert.match(projected, /"isError":true/);
	assert.doesNotMatch(projected, /"private"/);
	const squeezed = prepareRequest(context, { ...profile, contextWindow: 4_096 }, 1_024);
	assert.match(JSON.stringify(squeezed.context), /failure evidence/);
	assert.match(JSON.stringify(squeezed.context), /keep error evidence/);
});

test("request projection sheds old excerpts before rejecting a small context", () => {
	const literalMarker = "literal tool text\nExcerpt:\nkeep this suffix";
	const outputId = "12345678-1234-4123-8123-123456789abc";
	const messages: any[] = [
		{ role: "user", content: "Compare the inspected files", timestamp: 0 },
		{ role: "assistant", content: [{ type: "toolCall", id: "literal", name: "inspect_workspace", arguments: { path: "literal.txt" } }], api: "openai-completions", provider: "local", model: "small", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 1 },
		{ role: "toolResult", toolCallId: "literal", toolName: "inspect_workspace", content: [{ type: "text", text: literalMarker }], details: { path: "literal.txt" }, isError: false, timestamp: 2 },
	];
	for (let index = 0; index < 8; index++) {
		messages.push({ role: "assistant", content: [{ type: "toolCall", id: `call-${index}`, name: "inspect_workspace", arguments: { path: `${index}.txt` } }], api: "openai-completions", provider: "local", model: "small", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: index * 2 + 3 });
		messages.push({ role: "toolResult", toolCallId: `call-${index}`, toolName: index ? "inspect_workspace" : "inspect_workspace\nExcerpt:\nCUT", content: [{ type: "text", text: `${index}: ${"evidence ".repeat(1_700)}` }], details: { path: `${index}.txt`, sourceHash: String(index).repeat(64), ...(index ? {} : { outputId }) }, isError: false, timestamp: index * 2 + 4 });
	}
	const prepared = prepareRequest({ systemPrompt: "Preserve file identities", tools: [], messages } as any, { ...profile, contextWindow: 8_192 }, 1_024);
	assert.equal(prepared.omittedResults, 8);
	const projected = JSON.stringify(prepared.context);
	for (let index = 0; index < 8; index++) {
		assert.match(projected, new RegExp(`call-${index}`));
		assert.match(projected, new RegExp(`${index}\\.txt`));
	}
	assert.match(projected, /keep this suffix/);
	assert.match(projected, new RegExp(outputId));
});

test("literal search provenance survives compaction and remains explicitly historical after a write", async (t) => {
	const root = await tempDir(t, "codetonomy-search-provenance-");
	for (let index = 0; index < 20; index++) await writeFile(join(root, `source-${String(index).padStart(2, "0")}.txt`), `${index ? "" : "\uFEFF"}needle ${"x".repeat(600)}\n`);
	const inspected = await inspectWorkspaceTool(root).execute("inspect-bom", { path: "source-00.txt" });
	assert.equal((inspected.details as { sourceHash: string }).sourceHash, createHash("sha256").update(await readFile(join(root, "source-00.txt"))).digest("hex"));
	const result = await searchWorkspaceTool(root).execute("search", { query: "needle", limit: 100 });
	const details = result.details as { sourceRefs: Array<{ path: string; sourceHash: string }> };
	assert.equal(details.sourceRefs.length, 16);
	const original = details.sourceRefs[0]!;
	assert.equal(original.sourceHash, createHash("sha256").update(await readFile(join(root, original.path))).digest("hex"));
	await writeFile(join(root, original.path), "changed\n");
	const currentHash = createHash("sha256").update(await readFile(join(root, original.path))).digest("hex");
	assert.notEqual(currentHash, original.sourceHash);
	const context: any = { systemPrompt: "Use search evidence carefully", tools: [], messages: [
		{ role: "user", content: "Find the needle", timestamp: 0 },
		{ role: "assistant", content: [{ type: "toolCall", id: "search", name: "search_workspace", arguments: { query: "needle" } }], api: "openai-completions", provider: "local", model: "small", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 1 },
		{ role: "toolResult", toolCallId: "search", toolName: "search_workspace", content: result.content, details, isError: false, timestamp: 2 },
	] };
	const prepared = prepareRequest(context, { ...profile, contextWindow: 4_096 }, 1_024);
	assert.equal(prepared.omittedResults, 1);
	const projected = JSON.stringify(prepared.context);
	assert.match(projected, new RegExp(original.sourceHash));
	assert.match(projected, /historical source evidence; reread the path/);
});

test("shared admission accounts for concurrent reservations and keeps unknown attempts reserved", () => {
	const state: RunSpendBudgetState = { maxCostUsd: 0.004, costUsd: 0, totalTokens: 0 };
	const first = reserveRequest(state, 1000, 500, profile.cost);
	reserveRequest(state, 1000, 500, profile.cost);
	assert.throws(() => reserveRequest(state, 1, 1, profile.cost), /cost ceiling/);
	settleRequest(state, first, { totalTokens: 0, cost: { total: 0 } });
	assert.equal(state.reservedCostUsd, 0.004);
	settleRequest(state, first, { totalTokens: 110, cost: { total: 0.00012 } });
	assert.equal(state.reservedCostUsd, 0.002);
	assert.equal(state.costUsd, 0.00012);
});

test("wrong content in the correct file fails the exact-outcome check", async () => {
	for (const content of ["RED", "BLUE"]) {
		let calls = 0;
		const result = await run({ objective: "Write answer.txt containing exactly BLUE", maxModelTurns: 3 }, async () => ++calls === 1 ? response("", { name: "list_workspace", arguments: { path: "." } }) : calls === 2 ? response("", { name: "write_workspace", arguments: { path: "answer.txt", content } }) : response("Completed."));
		assert.equal(await readFile(join(result.task.acceptanceCriteria.find(c => c.target)!.target!), "utf8"), content);
		assert.equal(result.verification.passed, content === "BLUE", JSON.stringify(result.verification));
		assert.equal(result.verification.outcomeChecks, 1);
	}
});

test("a data extraction application verifies JSON without workspace or domain tools", async () => {
	for (const text of ['{"cents":1250}', '{"cents":12}']) {
		const result = await run({ objective: "Return JSON with cents for USD 12.50", application: { id: "price-extraction", toolIds: [], verify: async ({ output }) => { let passed = false; try { passed = JSON.parse(output).cents === 1250; } catch {} return { passed, checks: [{ id: "price", passed, message: "Price must be represented in cents" }] }; } } }, async () => response(text));
		assert.deepEqual(result.capabilities.toolIds, []);
		assert.equal(result.verification.passed, text.includes("1250"));
		assert.equal(result.verification.outcomeChecks, 1);
	}
});

test("application acceptance feedback reaches the primary model and permits a bounded repair", async (t) => {
	const root = await tempDir(t, "application-feedback-");
	const requests: Array<Record<string, unknown>> = [];
	const reply = (delta: Record<string, unknown>, reason: "stop" | "tool_calls") => new Response([
		{ id: `feedback-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "small", choices: [{ index: 0, delta, finish_reason: null }] },
		{ id: `feedback-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "small", choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
	].map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
	const result = await createHarness().run({
		objective: "Write status.txt", workspaceRoot: root, traceDirectory: join(root, "runs"), permissionMode: "auto", provider: "local", modelId: "small", maxModelTurns: 6, providerRetryLimit: 0,
		providerConfiguration: { id: "local", name: "Local", kind: "openai-compatible", baseUrl: "http://localhost:1234/v1", modelMetadata: { ...profile, contextWindow: 32_768 } }, toolSelection: "minimal",
		application: { id: "status-acceptance", verify: async ({ workspaceRoot }) => {
			const passed = await readFile(join(workspaceRoot, "status.txt"), "utf8").then(value => value === "fixed\n", () => false);
			return { passed, checks: [{ id: "state", passed, message: "status.txt must contain fixed" }] };
		} },
		providerFetch: async (_input, init) => {
			requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			const step = requests.length;
			if (step === 1) return reply({ role: "assistant", tool_calls: [{ index: 0, id: "list", type: "function", function: { name: "list_workspace", arguments: '{"path":"."}' } }] }, "tool_calls");
			if (step === 2 || step === 4) return reply({ role: "assistant", tool_calls: [{ index: 0, id: `write-${step}`, type: "function", function: { name: "write_workspace", arguments: JSON.stringify({ path: "status.txt", content: step === 2 ? "broken\n" : "fixed\n" }) } }] }, "tool_calls");
			return reply({ role: "assistant", content: step === 3 ? "Initial implementation complete." : "Repaired status.txt." }, "stop");
		},
	});
	assert.equal(result.verification.passed, true, JSON.stringify(result.verification));
	assert.equal(await readFile(join(root, "status.txt"), "utf8"), "fixed\n");
	assert.equal(requests.length, 5);
	assert.match(JSON.stringify(requests[3]), /status-acceptance:state.*status\.txt must contain fixed/);
});

test("retries reserve separately; successful usage settles only the latest attempt", async () => {
	let called = 0;
	const budget: RunSpendBudgetState = { maxCostUsd: 1, costUsd: 0, totalTokens: 0 };
	const result = await run({ providerRetryLimit: 1, spendBudgetState: budget }, async () => ++called === 1 ? Response.json({ error: { message: "temporary" } }, { status: 429, headers: { "retry-after": "0" } }) : response("OK"));
	assert.equal(called, 2);
	assert.equal(result.verification.passed, true);
	assert.equal(budget.totalTokens, 110);
	assert.ok(budget.reservedCostUsd! > 0);
	assert.ok(budget.costUsd > 0);
});

test("request-local accounting admits a worker and continuation and retains incomplete reservations", () => {
	const budget: RunSpendBudgetState = { maxTotalTokens: 10_000, maxCostUsd: 10, costUsd: 0, totalTokens: 0 };
	assertRequestAdmission(budget, [requestReservation(100, 50, profile.cost), requestReservation(200, 50, profile.cost)]);
	assert.throws(() => assertRequestAdmission({ ...budget, maxTotalTokens: 300 }, [requestReservation(100, 50, profile.cost), requestReservation(200, 50, profile.cost)]), /cannot admit/);
	const [workerHold, primaryHold] = reserveRequests(budget, [requestReservation(100, 50, profile.cost), requestReservation(200, 50, profile.cost)]);
	const worker = createRequestAccounting(budget, 100, 50, { cost: profile.cost, maxTokens: profile.maxTokens }, workerHold);
	const primary = createRequestAccounting(budget, 200, 50, { cost: profile.cost, maxTokens: profile.maxTokens }, primaryHold);
	assert.equal(budget.reservedTokens, 400);
	worker.startAttempt();
	primary.startAttempt();
	assert.equal(budget.reservedTokens, 400);
	worker.settle({ totalTokens: 25, cost: { total: 0.001 } }, true);
	primary.settle({ totalTokens: 0, cost: { total: 0 } }, false);
	assert.equal(budget.totalTokens, 25);
	assert.equal(budget.reservedTokens, 250);
	assert.throws(() => worker.settle({ totalTokens: 1, cost: { total: 0 } }), /already settled/);
});

test("old user constraints survive when the recent conversation projection drops their turns", async () => {
	let serialized = "";
	const conversation = Array.from({ length: 41 }, (_, index) => ({ runId: `r${index}`, objective: index === 0 ? "PERSISTENT_RULE_DO_NOT_TOUCH_GUARD" : `Note ${index}`, output: "Acknowledged.", timestamp: index + 1 }));
	const result = await run({ conversation }, async (_input, init) => { serialized = String(init?.body); return response("OK"); });
	assert.equal(result.verification.passed, true);
	assert.match(serialized, /PERSISTENT_RULE_DO_NOT_TOUCH_GUARD/);
	const trace = await readFile(result.tracePath, "utf8");
	assert.match(trace, /"omittedConversationTurns":1/);
});

test("OpenCode Go GLM Flash maps supported effort and rejects off before any request", async () => {
	let called = 0, body: any;
	const providerConfiguration = { id: "opencode-go", name: "OpenCode Go", kind: "opencode-go" as const, apiKey: "test-key", modelMetadata: { ...profile, id: "glm-5.3-flash", name: "GLM Flash", reasoning: true } };
	await assert.rejects(() => run({ provider: "opencode-go", modelId: "glm-5.3-flash", providerConfiguration, reasoningLevel: "off" }, async () => { called++; return response("OK"); }), /requires reasoning/);
	const result = await run({ provider: "opencode-go", modelId: "glm-5.3-flash", providerConfiguration, reasoningLevel: "low" }, async (_input, init) => { called++; body = JSON.parse(String(init?.body)); return response("OK"); });
	assert.equal(result.verification.passed, true);
	assert.equal(called, 1);
	assert.equal(body.reasoning_effort, "low");
	assert.equal(body.thinking, undefined);
});

test("request output defaults can use the model limit without a quarter-window cap", () => {
 const context = { systemPrompt: "Answer briefly", messages: [], tools: [] };
 const large = prepareRequest(context, { contextWindow: 1_000_000, maxTokens: 384_000 }, 384_000);
 assert.equal(large.maxOutputTokens, 384_000);
 const shared = prepareRequest(context, { contextWindow: 4_096, maxTokens: 4_096 }, 4_096);
 assert.equal(shared.inputTokens + shared.maxOutputTokens, 4_096);
 assert.ok(shared.maxOutputTokens > 1_024);
 assert.equal(prepareRequest(context, { contextWindow: 4_096, maxTokens: 4_096 }, 128).maxOutputTokens, 128);
});

test("runtime uses a bounded output default and preserves explicit limits above 128K", async () => {
 const metadata = { ...profile, contextWindow: 1_000_000, maxTokens: 384_000 };
 for (const explicit of [undefined, 200_000]) {
  const result = await run({maxOutputTokens: explicit, providerConfiguration: {id: "local", name: "Local", kind: "openai-compatible", baseUrl: "http://localhost:1234/v1", modelMetadata: metadata}}, async (_input, init) => {
   const body = JSON.parse(String(init?.body));
   assert.equal(body.max_tokens ?? body.max_completion_tokens, explicit ?? 16_384);
   return response("Ready");
  });
  assert.equal(result.verification.passed, true);
 }
});

test("local admission retains its reason through provider wrapping and releases unsent reservations", async () => {
 const { RequestAdmissionError } = await import('../packages/runtime/src/request-budget.ts');
 const state: RunSpendBudgetState = {maxCostUsd: 10, maxTotalTokens: 100000, costUsd: 0, totalTokens: 0};
 let attempts = 0;
 const result = await run({maxCostUsd:10,maxTotalTokens:100000,spendBudgetState:state}, async()=>{
  attempts++;
  throw new RequestAdmissionError('cost','Trial cost ceiling cannot admit the next request',{limit:10,requested:11});
 });
 assert.equal(attempts,1);
 assert.match(JSON.stringify(result.verification),/Trial cost ceiling/);
 assert.doesNotMatch(JSON.stringify(result.verification),/Connection error/);
 const events=(await readFile(result.tracePath,'utf8')).trim().split('\n').map((line) => JSON.parse(line));
 const failed=events.find(e=>e.type==='model.request.failed');
 assert.equal(failed.data.outcome,'local-cost-limit');
 assert.equal(failed.data.requestSent,false);
 assert.equal(state.reservedCostUsd,0);
 assert.equal(state.reservedTokens,0);
});

test("token admission rejection is local and sends no provider request", async () => {
 let sent=0;
 const result=await run({maxTotalTokens:1},async()=>{sent++;return response('Should not run');});
 assert.equal(sent,0);
 const events=(await readFile(result.tracePath,'utf8')).trim().split('\n').map((line) => JSON.parse(line));
 const failed=events.find(e=>e.type==='model.request.failed');
 assert.equal(failed.data.outcome,'local-tokens-limit');
 assert.equal(failed.data.requestSent,false);
 assert.equal(failed.data.admission.limit,1);
 assert.ok(failed.data.admission.requested>1);
});
