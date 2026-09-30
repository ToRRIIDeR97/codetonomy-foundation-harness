// Delegated work is credited to the parent: verified child writes count as the parent's
// workspace change, and child usage is part of the parent's usage.
// Ported from codetonomy Implementations/delegation-evidence-and-usage (PRs 58 and 59).
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createHarness } from "../packages/runtime/src/index.ts";
import { createOrchestrationModule } from "../packages/module-orchestration/src/index.ts";
import type { HarnessModule } from "../packages/tools/src/index.ts";
import { tempDir } from "./support/temp.ts";

type Body = { messages?: Array<{ role?: string; content?: unknown }>; tools?: Array<{ function?: { name?: string } }> };
const TOKENS_PER_REQUEST = 46;
const names = (body: Body) => (body.tools ?? []).map(({ function: fn }) => fn?.name);
const toolResults = (body: Body) => (body.messages ?? []).filter(({ role }) => role === "tool").length;
const reply = (index: number, delta: Record<string, unknown>, finish: string) => new Response([
	{ id: `d-${index}`, object: "chat.completion.chunk", created: 1, model: "d-model", choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] },
	{ id: `d-${index}`, object: "chat.completion.chunk", created: 1, model: "d-model", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: TOKENS_PER_REQUEST } },
].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
const call = (index: number, name: string, args: unknown) => reply(index, { tool_calls: [{ index: 0, id: `call-${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
const provider = { provider: "d-provider", modelId: "d-model", providerConfiguration: { id: "d-provider", name: "Delegation", kind: "openai-compatible" as const, baseUrl: "https://delegation.test/v1", apiKey: "d-key" } };
const OBJECTIVE = "Create notes.txt containing hello";

test("AC-1/AC-2: a verified child's write is the parent's workspace change, and the child's usage is in the parent's", async (t) => {
	const root = await tempDir(t, "delegation-evidence-");
	await writeFile(join(root, "README.md"), "# Notes\n");
	const bodies: Body[] = [];
	const providerFetch: typeof fetch = async (_input, init) => {
		const body = JSON.parse(String(init?.body)) as Body;
		bodies.push(body);
		const index = bodies.length, step = toolResults(body);
		if (names(body).includes("delegate_tasks")) {
			// Parent: look around, delegate the write, then answer without writing.
			if (step === 0) return call(index, "list_workspace", { path: ".", depth: 1 });
			if (step === 1) return call(index, "delegate_tasks", { nodes: [{ id: "writer", objective: "Write notes.txt containing hello", presetId: "general-worker", permissionProfileId: "workspace-write", writePaths: ["notes.txt"] }] });
			return reply(index, { content: "The child created notes.txt containing hello." }, "stop");
		}
		// Child: look around, write the file, then answer.
		if (step === 0) return call(index, "list_workspace", { path: ".", depth: 1 });
		if (step === 1) return call(index, "write_workspace", { path: "notes.txt", content: "hello\n" });
		return reply(index, { content: "Wrote notes.txt containing hello." }, "stop");
	};
	const result = await createHarness().run({ objective: OBJECTIVE, workspaceRoot: root, traceDirectory: join(root, "runs"), permissionMode: "auto", maxModelTurns: 8, modules: [createOrchestrationModule()], ...provider, providerFetch });
	const events = (await readFile(result.tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });

	assert.equal(await readFile(join(root, "notes.txt"), "utf8"), "hello\n");
	assert.equal(result.verification.passed, true, JSON.stringify(result.verification.checks));
	assert.equal(events.filter(({ type }) => type === "verification.failed").length, 0, "no failed first verification");
	assert.equal(events.find(({ type }) => type === "run.completed")?.data.actionNudgeIssued, false, "no nudge to redo the child's work");
	assert.equal(events.filter(({ type, data }) => type === "tool.requested" && data.toolId === "write_workspace").length, 0, "the parent never wrote");
	assert.deepEqual(result.changedPaths, ["notes.txt"]);

	const parentRequests = events.filter(({ type }) => type === "model.request.started").length;
	assert.ok(bodies.length > parentRequests, "the child made its own requests");
	assert.equal(result.usage.totalTokens, bodies.length * TOKENS_PER_REQUEST, "parent usage includes every child request");
	assert.equal(result.usage.input, bodies.length * 40);
	assert.equal(result.usage.output, bodies.length * 6);
});

test("AC-3: read tools and paths outside the workspace are never credited as a workspace change", async (t) => {
	const root = await tempDir(t, "delegation-evidence-guard-");
	await writeFile(join(root, "README.md"), "# Notes\n");
	const tool = (name: string, access: "read" | "approval", changedPaths: string[], write?: boolean): NonNullable<HarnessModule["tools"]>[number] => ({
		definition: { name, version: "1", description: `Test tool ${name}`, parameters: { type: "object", properties: {}, additionalProperties: false } },
		access,
		create: () => ({
			name, label: name, description: `Test tool ${name}`,
			parameters: { type: "object", properties: {}, additionalProperties: false } as never,
			async execute() {
				if (write) await writeFile(join(root, "notes.txt"), "hello\n");
				return { content: [{ type: "text" as const, text: "done" }], details: { changedPaths, additionalUsage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } };
			},
		}),
	});
	const module: HarnessModule = { id: "guard-test", tools: [tool("read_tool_claims", "read", ["notes.txt"], true), tool("approval_tool_outside", "approval", ["../outside.txt", "/etc/hosts"])] };
	let requests = 0;
	const providerFetch: typeof fetch = async (_input, init) => {
		const body = JSON.parse(String(init?.body)) as Body;
		const index = ++requests, step = toolResults(body);
		if (step === 0) return call(index, "list_workspace", { path: ".", depth: 1 });
		if (step === 1) return call(index, "read_tool_claims", {});
		if (step === 2) return call(index, "approval_tool_outside", {});
		return reply(index, { content: "notes.txt now contains hello." }, "stop");
	};
	const result = await createHarness().run({ objective: OBJECTIVE, workspaceRoot: root, traceDirectory: join(root, "runs"), permissionMode: "auto", maxModelTurns: 6, modules: [module], ...provider, providerFetch });
	assert.equal(result.verification.checks.find(({ id }) => id === "workspace-change")?.passed, false, JSON.stringify(result.verification.checks));
	assert.equal(result.changedPaths, undefined);
	// Only the approval tool's usage report is added; the read tool's is ignored like its paths.
	assert.equal(result.usage.totalTokens, requests * TOKENS_PER_REQUEST + 2);
});

test("AC-4: when delegation fails, the failed children's usage is still in the parent's usage", async (t) => {
	const root = await tempDir(t, "delegation-evidence-failed-");
	await writeFile(join(root, "README.md"), "# Notes\n");
	const bodies: Body[] = [];
	const providerFetch: typeof fetch = async (_input, init) => {
		const body = JSON.parse(String(init?.body)) as Body;
		bodies.push(body);
		const index = bodies.length, step = toolResults(body);
		if (names(body).includes("delegate_tasks")) {
			if (step === 0) return call(index, "list_workspace", { path: ".", depth: 1 });
			if (step === 1) return call(index, "delegate_tasks", { nodes: [{ id: "writer", objective: "Write notes.txt containing hello", presetId: "general-worker", permissionProfileId: "workspace-write", writePaths: ["notes.txt"] }] });
			return reply(index, { content: "Delegation failed; notes.txt was not created." }, "stop");
		}
		// Child: looks around, then claims success without writing, so it never verifies.
		if (step === 0) return call(index, "list_workspace", { path: ".", depth: 1 });
		return reply(index, { content: "Done." }, "stop");
	};
	const result = await createHarness().run({ objective: OBJECTIVE, workspaceRoot: root, traceDirectory: join(root, "runs"), permissionMode: "auto", maxModelTurns: 6, modules: [createOrchestrationModule()], ...provider, providerFetch });
	const events = (await readFile(result.tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
	assert.equal(events.filter(({ type, data }) => type === "tool.failed" && data.toolId === "delegate_tasks").length, 1, "delegation failed");
	const parentRequests = events.filter(({ type }) => type === "model.request.started").length;
	assert.ok(bodies.length > parentRequests, "the child made its own requests");
	assert.equal(result.usage.totalTokens, bodies.length * TOKENS_PER_REQUEST, "parent usage includes the failed child's requests");
	assert.equal(result.changedPaths, undefined, "a failed child's work is not credited");
});
