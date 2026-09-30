// Delegation wastes no child runs, context or cache: mismatched presets fail before any child
// starts, failed delegations still hand back verified work, results show each output once,
// children inherit the parent's cache and context settings, and same-prefix siblings warm the cache once.
// Ported from codetonomy Implementations/delegation-optimizations (PR 60).
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { HarnessEvent, RunResult } from "../packages/contracts/src/index.ts";
import { createHarness } from "../packages/runtime/src/index.ts";
import { createOrchestrationModule, runHarnessOrchestration } from "../packages/module-orchestration/src/index.ts";
import { runOrchestration, type OrchestrationNode } from "../packages/orchestration/src/index.ts";
import { compileTask } from "../packages/task-compiler/src/index.ts";
import type { HarnessModule, HarnessModuleRunContext } from "../packages/tools/src/index.ts";
import { tempDir } from "./support/temp.ts";

type Body = { messages?: Array<{ role?: string; content?: unknown }>; tools?: Array<{ function?: { name?: string } }> };
const TOKENS_PER_REQUEST = 46;
const names = (body: Body) => (body.tools ?? []).map(({ function: fn }) => fn?.name);
const toolResults = (body: Body) => (body.messages ?? []).filter(({ role }) => role === "tool").length;
const toolMessages = (body: Body | undefined) => (body?.messages ?? []).filter(({ role }) => role === "tool").map(({ content }) => typeof content === "string" ? content : JSON.stringify(content));
const mentions = (body: Body, text: string) => JSON.stringify(body.messages ?? []).includes(text);
const reply = (index: number, delta: Record<string, unknown>, finish: string) => new Response([
	{ id: `o-${index}`, object: "chat.completion.chunk", created: 1, model: "o-model", choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] },
	{ id: `o-${index}`, object: "chat.completion.chunk", created: 1, model: "o-model", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: TOKENS_PER_REQUEST } },
].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
const call = (index: number, name: string, args: unknown) => reply(index, { tool_calls: [{ index: 0, id: `call-${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
const answer = (index: number, content: string) => reply(index, { content }, "stop");
const provider = { provider: "o-provider", modelId: "o-model", providerConfiguration: { id: "o-provider", name: "Optimizations", kind: "openai-compatible" as const, baseUrl: "https://delegation-optimizations.test/v1", apiKey: "o-key" } };
const fixture = (root: string) => ({ workspaceRoot: root, traceDirectory: join(root, "runs"), provider: "fixture", modelId: "faux-1", permissionMode: "auto" as const });
const delegateTool = (root: string, inheritedOptions: Record<string, unknown>, permissionProfileId = "workspace-write") =>
	createOrchestrationModule().tools![0]!.create({ workspaceRoot: root, privatePaths: [], run: { depth: 0, permissionProfileId, inheritedOptions } });
const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content[0]?.type === "text" ? result.content[0].text ?? "" : "";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

test("AC-1: a preset/profile mismatch is rejected before any child starts", async (t) => {
	const root = await tempDir(t, "delegation-mismatch-");
	const events: HarnessEvent[] = [];
	const tool = delegateTool(root, { ...fixture(root), observers: [(event: HarnessEvent) => { events.push(event); }] });
	await assert.rejects(
		tool.execute("mismatch", { nodes: [
			{ id: "fine", objective: "Say fine", presetId: "general-assistant", permissionProfileId: "workspace-read" },
			{ id: "writer", objective: "Say writer", presetId: "general-assistant", permissionProfileId: "workspace-write" },
		] }),
		/Child writer uses preset general-assistant, which runs workspace-read; set permissionProfileId to workspace-read/,
	);
	assert.equal(events.length, 0, "no orchestration or child run started");

	let requests = 0;
	await assert.rejects(runHarnessOrchestration({
		...provider, workspaceRoot: root, traceDirectory: join(root, "runs"), permissionMode: "auto", parentPermissionProfileId: "workspace-write",
		providerFetch: async () => { requests++; return answer(requests, "Child answer."); },
		nodes: [{ id: "reader", objective: "Say reader", presetId: "general-worker", permissionProfileId: "workspace-read" }],
	}), /Child reader uses preset general-worker, which runs workspace-write/);
	assert.equal(requests, 0, "no provider request was made");

	// A child that finished but changed its profile keeps its run for inspection.
	const node: OrchestrationNode = { id: "drift", objective: "Drift", presetId: "general-worker", permissionProfileId: "workspace-write" };
	const result = await runOrchestration({
		workspaceRoot: root, nodes: [node], parentPermissionProfileId: "workspace-write",
		execute: async () => ({
			runId: "run-drift", output: "drifted", artifacts: [], tracePath: join(root, "drift.jsonl"),
			task: { id: "task-drift", objective: "Drift", inputs: [], requiredCapabilities: [], acceptanceCriteria: [], riskClass: "low" },
			capabilities: { preset: { id: "general-worker", version: "1", purpose: "test", coreSkillIds: [], toolIds: [], permissionProfileId: "workspace-read", verifierIds: [], cacheStrategy: "AUTO_PREFIX" }, skillIds: [], toolIds: [], permissionProfileId: "workspace-read", verifierIds: [], toolBundleHash: "t", skillPackHash: "s", contextPacketHash: "c", cachePrefixHash: "p", runProfileHash: "r" },
			verification: { passed: true, checks: [] },
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
		} as RunResult),
		synthesize: async () => "",
		verifyFinal: async () => ({ passed: true, checks: [] }),
	});
	assert.equal(result.children[0]!.status, "failed");
	assert.match(result.children[0]!.error ?? "", /changed permission profile from workspace-write to workspace-read/);
	assert.equal(result.children[0]!.run?.runId, "run-drift", "the finished run is kept");
});

test("AC-2: a failed delegation still hands the parent its completed children's output, files and usage", async (t) => {
	const root = await tempDir(t, "delegation-partial-");
	await writeFile(join(root, "README.md"), "# Notes\n");
	const bodies: Body[] = [];
	const parentBodies: Body[] = [];
	const providerFetch: typeof fetch = async (_input, init) => {
		const body = JSON.parse(String(init?.body)) as Body;
		bodies.push(body);
		const index = bodies.length, step = toolResults(body);
		if (names(body).includes("delegate_tasks")) {
			parentBodies.push(body);
			if (step === 0) return call(index, "delegate_tasks", { nodes: [
				{ id: "writer", objective: "Write notes.txt containing hello", presetId: "general-worker", permissionProfileId: "workspace-write", writePaths: ["notes.txt"] },
				{ id: "auditor", objective: "Audit the build scripts", presetId: "general-assistant", permissionProfileId: "workspace-read" },
			] });
			return answer(index, "notes.txt is written; the audit failed.");
		}
		// The auditor refuses, which fails its verification; the writer succeeds.
		if (mentions(body, "Audit the build scripts")) return answer(index, "I can't help with that. I don't have access to the tools needed.");
		if (step === 0) return call(index, "list_workspace", { path: ".", depth: 1 });
		if (step === 1) return call(index, "write_workspace", { path: "notes.txt", content: "hello\n" });
		return answer(index, "WRITER-OUTPUT: wrote notes.txt containing hello.");
	};
	const result = await createHarness().run({ objective: "Create notes.txt containing hello", workspaceRoot: root, traceDirectory: join(root, "runs"), permissionMode: "auto", maxModelTurns: 6, modules: [createOrchestrationModule()], ...provider, providerFetch });
	const events = (await readFile(result.tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as HarnessEvent);

	const [message] = toolMessages(parentBodies[1]);
	assert.ok(message, "the parent model received the delegate_tasks result");
	const [summary] = message.split("\n\n");
	assert.match(summary!, /^Delegated child work failed verification: auditor=failed \(/, `message: ${message}`);
	assert.ok(Buffer.byteLength(summary!) <= 2_000, "the failure summary keeps its bound");
	assert.ok(message.includes("## writer"), "the completed child is named");
	assert.ok(message.includes("WRITER-OUTPUT: wrote notes.txt containing hello."), "the completed child's output reaches the model");

	assert.equal(await readFile(join(root, "notes.txt"), "utf8"), "hello\n");
	assert.deepEqual(result.changedPaths, ["notes.txt"], "the completed child's file is the parent's change");
	assert.equal(events.filter(({ type, data }) => type === "tool.requested" && data.toolId === "write_workspace").length, 0, "the parent never wrote");
	assert.equal(result.usage.totalTokens, bodies.length * TOKENS_PER_REQUEST, "parent usage includes every child request, failed ones too");
	const failed = events.find(({ type, data }) => type === "tool.failed" && data.toolId === "delegate_tasks");
	assert.match(String(failed?.data.message ?? ""), /auditor=failed/, "the trace records the failure summary");
});

test("AC-3: a verified result is plain text and shows each child's output once, within one shared budget", async (t) => {
	const root = await tempDir(t, "delegation-result-");
	const long = `LONG-START ${"lorem ipsum ".repeat(4_000)}`;
	const tool = delegateTool(root, {
		...provider, workspaceRoot: root, traceDirectory: join(root, "runs"), permissionMode: "auto",
		providerFetch: async (_input: unknown, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as Body;
			return answer(1, mentions(body, "Explain everything at length") ? long : "SHORT-ANSWER: four.");
		},
	}, "workspace-read");
	const result = await tool.execute("delegate", { nodes: [
		{ id: "long", objective: "Explain everything at length", presetId: "general-assistant", permissionProfileId: "workspace-read" },
		{ id: "short", objective: "Answer briefly: what is 2+2?", presetId: "general-assistant", permissionProfileId: "workspace-read" },
	] });
	const visible = text(result);
	assert.match(visible, /^Delegation verified: 2 of 2 children completed\.\n- long: completed \(run [0-9a-f-]{36}\)\n- short: completed \(run [0-9a-f-]{36}\)\n\n## long\n\n/);
	assert.equal(occurrences(visible, "LONG-START"), 1, "the long output appears once");
	assert.equal(occurrences(visible, "SHORT-ANSWER: four."), 1, "the short output appears once, whole");
	assert.ok(!visible.includes("\\n"), "no escaped line breaks");
	assert.ok(Buffer.byteLength(visible) <= 17_000, `outputs share one budget (${Buffer.byteLength(visible)} bytes)`);
	const details = result.details as { verificationPassed: boolean; children: Array<{ id: string; output?: string }> };
	assert.equal(details.verificationPassed, true, "details keep the structured result");
	assert.equal(details.children.find(({ id }) => id === "short")?.output, "SHORT-ANSWER: four.");

	const fixtureTool = delegateTool(root, fixture(root), "workspace-read");
	const fixtureText = text(await fixtureTool.execute("fixture", { nodes: [
		{ id: "alpha", objective: "Say alpha", presetId: "general-assistant", permissionProfileId: "workspace-read" },
		{ id: "beta", objective: "Say beta", presetId: "general-assistant", permissionProfileId: "workspace-read" },
	] }));
	assert.equal(occurrences(fixtureText, "Fixture agent completed: Say alpha"), 1);
	assert.equal(occurrences(fixtureText, "Fixture agent completed: Say beta"), 1);
});

test("AC-4: children inherit cacheRetention, contextRetentionTokens and actionNudgeMode", async (t) => {
	const root = await tempDir(t, "delegation-inherit-");
	const seen: HarnessModuleRunContext[] = [];
	const capture: HarnessModule = { id: "capture", tools: [{
		definition: { name: "capture_run", version: "1", description: "Captures the run context", parameters: { type: "object", properties: {}, additionalProperties: false } },
		access: "approval",
		create: ({ run }) => {
			if (run) seen.push(run);
			return { name: "capture_run", label: "capture", description: "Captures the run context", parameters: { type: "object", properties: {} } as never, execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }) };
		},
	}] };
	await createHarness().run({ ...fixture(root), objective: "Say hi", modules: [capture], cacheRetention: "none", contextRetentionTokens: 50_000, actionNudgeMode: "message-only" });
	assert.ok(seen.length > 0, "the module tool was created for the run");
	const inherited = seen[0]!.inheritedOptions;
	assert.equal(inherited.cacheRetention, "none");
	assert.equal(inherited.contextRetentionTokens, 50_000);
	assert.equal(inherited.actionNudgeMode, "message-only");
});

test("AC-5: same-prefix siblings wait for the first child's first response; other groups and a zero wait do not", async (t) => {
	const root = await tempDir(t, "delegation-warmup-");
	const scenario = async (nodes: OrchestrationNode[], options: { leaderDelayMs?: number; cacheWarmupMaximumWaitMs?: number } = {}) => {
		const log: string[] = [];
		const started = new Map<string, number>();
		const result = await runHarnessOrchestration({
			...provider, workspaceRoot: root, traceDirectory: join(root, "runs"), permissionMode: "auto", parentPermissionProfileId: "workspace-write",
			...(options.cacheWarmupMaximumWaitMs === undefined ? {} : { cacheWarmupMaximumWaitMs: options.cacheWarmupMaximumWaitMs }),
			nodes,
			providerFetch: async (_input, init) => {
				const body = JSON.parse(String(init?.body)) as Body;
				const who = nodes.find(({ objective }) => mentions(body, objective))!.id;
				const first = !started.has(who);
				if (first) started.set(who, performance.now());
				log.push(`${who}:start`);
				if (who === nodes[0]!.id && first) await delay(options.leaderDelayMs ?? 200);
				log.push(`${who}:answered`);
				return answer(log.length, `Child ${who} answer.`);
			},
		});
		return { log, started, result };
	};
	const reader = (id: string): OrchestrationNode => ({ id, objective: `Say ${id}`, presetId: "general-assistant", permissionProfileId: "workspace-read" });

	const same = await scenario([reader("alpha"), reader("beta")]);
	assert.ok(same.log.indexOf("beta:start") > same.log.indexOf("alpha:answered"), `beta waited for alpha's first response: ${same.log.join(", ")}`);
	const trace = (await readFile(same.result.tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as HarnessEvent);
	assert.equal(trace.find(({ type }) => type === "capabilities.resolved")?.data.cacheWarmup, true);

	const differentGroups = await scenario([reader("alpha"), { id: "beta", objective: "Say beta", presetId: "general-worker", permissionProfileId: "workspace-write", writePaths: ["beta.txt"] }]);
	assert.ok(differentGroups.log.indexOf("beta:start") < differentGroups.log.indexOf("alpha:answered"), `different prefixes start together: ${differentGroups.log.join(", ")}`);

	const disabled = await scenario([reader("alpha"), reader("beta")], { cacheWarmupMaximumWaitMs: 0 });
	assert.ok(disabled.log.indexOf("beta:start") < disabled.log.indexOf("alpha:answered"), `a zero wait disables warm-up: ${disabled.log.join(", ")}`);

	const bounded = await scenario([reader("alpha"), reader("beta")], { leaderDelayMs: 1_500, cacheWarmupMaximumWaitMs: 100 });
	assert.ok(bounded.log.indexOf("beta:start") < bounded.log.indexOf("alpha:answered"), `a slow first child does not hold its sibling: ${bounded.log.join(", ")}`);
	const waited = bounded.started.get("beta")! - bounded.started.get("alpha")!;
	assert.ok(waited >= 90 && waited < 1_400, `the sibling waited about the bound (${Math.round(waited)} ms)`);
});

test("AC-6: a later verified delegation of the failed children resolves the failed delegation; other ids do not", async (t) => {
	const scenario = async (retryId: string) => {
		const root = await tempDir(t, "delegation-recovery-");
		await writeFile(join(root, "README.md"), "# Notes\n");
		const providerFetch: typeof fetch = async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as Body;
			const step = toolResults(body);
			if (names(body).includes("delegate_tasks")) {
				if (step === 0) return call(1, "list_workspace", { path: ".", depth: 1 });
				if (step === 1) return call(2, "delegate_tasks", { nodes: [{ id: "auditor", objective: "Audit the build scripts", presetId: "general-assistant", permissionProfileId: "workspace-read" }] });
				if (step === 2) return call(3, "delegate_tasks", { nodes: [{ id: retryId, objective: "Summarize the README", presetId: "general-assistant", permissionProfileId: "workspace-read" }] });
				return answer(4, "The README is a notes heading.");
			}
			if (mentions(body, "Audit the build scripts")) return answer(5, "I can't help with that. I don't have access to the tools needed.");
			if (step === 0) return call(6, "inspect_workspace", { path: "README.md" });
			return answer(7, "The README contains a Notes heading.");
		};
		// Children spend from the parent's turn budget.
		const result = await createHarness().run({ objective: "Summarize the workspace README", workspaceRoot: root, traceDirectory: join(root, "runs"), permissionMode: "auto", maxModelTurns: 12, modules: [createOrchestrationModule()], ...provider, providerFetch });
		const events = (await readFile(result.tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as HarnessEvent);
		return { result, events };
	};
	const retried = await scenario("auditor");
	assert.equal(retried.events.filter(({ type, data }) => type === "tool.failed" && data.toolId === "delegate_tasks").length, 1);
	assert.ok(retried.events.some(({ type }) => type === "tool.failure.resolved"), "the retry resolved the failed delegation");
	assert.equal(retried.result.verification.checks.find(({ id }) => id === "runtime-complete")?.passed, true, JSON.stringify(retried.result.verification.checks));

	const unrelated = await scenario("reader");
	assert.ok(!unrelated.events.some(({ type }) => type === "tool.failure.resolved"), "a different child id does not resolve it");
	assert.equal(unrelated.result.verification.checks.find(({ id }) => id === "runtime-complete")?.passed, false);
});

test("AC-7: files a write only reads are inputs, negated verb lists are prohibitions, and writes outside writePaths are never required", async (t) => {
	const root = "/ws";
	const compiled = (objective: string, writePaths?: string[]) => {
		const task = compileTask({ objective, workspaceRoot: root, ...(writePaths ? { writePaths } : {}) });
		return {
			writes: task.acceptanceCriteria.filter(({ action }) => action === "write" || action === "delete").map(({ target }) => target),
			prohibited: (task.prohibitions ?? []).map(({ target }) => target),
		};
	};
	const cases: Array<[string, string[], string[]?]> = [
		["Read the file notes/alpha.md in the workspace. Then create a new file named alpha.txt in the workspace root containing exactly one sentence that summarizes the content of notes/alpha.md.", ["/ws/alpha.txt"]],
		["Read notes/alpha.md and write a new file alpha.txt in the workspace root with a one-sentence summary of notes/alpha.md.", ["/ws/alpha.txt"]],
		["Step 1: read the file notes/alpha.md. You must never write, edit, or overwrite notes/alpha.md. Step 2: create alpha.txt with a summary.", ["/ws/alpha.txt"], ["/ws/notes/alpha.md"]],
		["Write a summary of notes/a.md to out.txt", ["/ws/out.txt"]],
		["Create a copy of a.txt at b.txt", ["/ws/b.txt"]],
		["Update src/config.ts to match the schema in docs/schema.md", ["/ws/src/config.ts"]],
		["Implement src/module.ts from docs/spec.md", ["/ws/src/module.ts"]],
		// Unchanged behaviour.
		["Fix the bug in src/app.ts", ["/ws/src/app.ts"]],
		["Update the contents of src/a.ts", ["/ws/src/a.ts"]],
		["Create src/a.ts and src/b.ts", ["/ws/src/a.ts", "/ws/src/b.ts"]],
		["Do not modify README.md", [], ["/ws/README.md"]],
	];
	for (const [objective, writes, prohibited = []] of cases) {
		const result = compiled(objective);
		assert.deepEqual(result.writes, writes, objective);
		assert.deepEqual(result.prohibited, prohibited, objective);
	}
	// A run limited to writePaths is never required to change anything else.
	assert.deepEqual(compiled("Update a.txt and b.txt", ["a.txt"]), { writes: ["/ws/a.txt"], prohibited: ["/ws/b.txt"] });
	assert.deepEqual(compiled("Update src/a.ts and src/b.ts", ["src"]).writes, ["/ws/src/a.ts", "/ws/src/b.ts"], "a directory claim covers its files");

	// End to end: the child objective that failed in the live check now verifies.
	const workspace = await tempDir(t, "delegation-compile-");
	await mkdir(join(workspace, "notes"));
	await writeFile(join(workspace, "notes", "alpha.md"), "# Alpha\nAlpha ingests sensor readings.\n");
	const objective = "Read the file notes/alpha.md in the workspace. Then create a new file named alpha.txt in the workspace root containing exactly one sentence that summarizes the content of notes/alpha.md.";
	const result = await runHarnessOrchestration({
		...provider, workspaceRoot: workspace, traceDirectory: join(workspace, "runs"), permissionMode: "auto", parentPermissionProfileId: "workspace-write",
		nodes: [{ id: "alpha", objective, presetId: "general-worker", permissionProfileId: "workspace-write", writePaths: ["alpha.txt"] }],
		providerFetch: async (_input, init) => {
			const step = toolResults(JSON.parse(String(init?.body)) as Body);
			if (step === 0) return call(1, "inspect_workspace", { path: "notes/alpha.md" });
			if (step === 1) return call(2, "write_workspace", { path: "alpha.txt", content: "Alpha ingests sensor readings.\n" });
			return answer(3, "Wrote alpha.txt.");
		},
	});
	assert.equal(result.verification.passed, true, JSON.stringify(result.children[0]?.error));
	assert.equal(await readFile(join(workspace, "notes", "alpha.md"), "utf8"), "# Alpha\nAlpha ingests sensor readings.\n");
});
