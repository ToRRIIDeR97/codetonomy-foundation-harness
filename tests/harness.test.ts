import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { isSensitiveWorkspacePath } from "../packages/contracts/src/index.ts";
import { buildStableSystemPrompt, resolveCapabilities } from "../packages/capability-compiler/src/index.ts";
import { getPermissionProfile, PermissionGate } from "../packages/permissions/src/index.ts";
import { createHarness, projectConversation } from "../packages/runtime/src/index.ts";
import { createOrchestrationModule, runHarnessOrchestration } from "../packages/module-orchestration/src/index.ts";
import { previewCheckpoint, RunCheckpoint, rewindCheckpoint } from "../packages/runtime/src/checkpoint.ts";
import { compileTask } from "../packages/task-compiler/src/index.ts";
import { skipWithoutRipgrep } from "./support/environment.ts";
import {
	editWorkspaceTool,
	createSandboxInvocation,
	CommandOutputStore,
	filterSandboxEnvironment,
	inspectWorkspaceTool,
	listWorkspaceTool,
	toolCacheDefinitions,
	searchWorkspaceTool,
	runWorkspaceCommandTool,
	secretFileDenyEntries,
	READ_ONLY_TOOL_IDS,
	writeWorkspaceTool,
} from "../packages/tools/src/index.ts";
import { verifyOutput } from "../packages/verifiers/src/index.ts";
import { tempDirs } from "./support/temp.ts";

const temporaryDirectory = tempDirs();

const commandOutputStore = (workspaceRoot: string) => new CommandOutputStore({
	workspaceRoot,
	outputDirectory: join(workspaceRoot, `.command-output-${randomUUID()}`),
});

test("every provider-facing tool uses an object-root JSON schema", () => {
	for (const definition of Object.values(toolCacheDefinitions)) assert.equal((definition.parameters as { type?: string }).type, "object", definition.name);
});

test("read-only tools are permissioned and structured inspection satisfies workspace evidence", () => {
	for (const profileId of ["workspace-read", "workspace-write"]) {
		const profile = getPermissionProfile(profileId);
		for (const toolId of READ_ONLY_TOOL_IDS) assert.equal(profile.toolDecisions[toolId], "ALLOW", `${profileId}/${toolId}`);
	}
	const task = compileTask({ objective: "Inspect the attached report", files: ["report.pdf"] });
	assert.equal(verifyOutput("The report was inspected.", undefined, { task, completedToolIds: ["inspect_document"], workspaceEvidenceToolIds: ["inspect_document"] }).passed, true);
	assert.equal(verifyOutput("The report was inspected.", undefined, { task, completedToolIds: ["inspect_document"] }).passed, false);
});

test("sensitive workspace path policy is platform-independent", () => {
	for (const path of [".env", "config/.env.production", ".ssh", ".ssh/id_ed25519", "config/secrets.yaml", "certs/server.pem", "nested\\.npmrc", ".kube/config", "nested\\.kube\\config"]) {
		assert.equal(isSensitiveWorkspacePath(path), true, path);
	}
	for (const path of ["src/environment.ts", "docs/secrets-management.md", "certs/server.pem.example", ".kube/config.example"]) {
		assert.equal(isSensitiveWorkspacePath(path), false, path);
	}
});

test("system prompt teaches the enabled tool contract without advertising unavailable tools", () => {
	const capabilities = resolveCapabilities(compileTask({ objective: "Implement the requested change" }));
	const prompt = buildStableSystemPrompt(capabilities.preset, ["inspect_workspace", "edit_workspace", "run_workspace_command"]);
	assert.match(prompt, /coding agent/);
	assert.match(prompt, /exact tool name.*one JSON object/);
	assert.match(prompt, /workspace-relative paths/);
	assert.match(prompt, /Never inspect filesystem root/);
	assert.match(prompt, /retrieved context before calling discovery tools/);
	assert.doesNotMatch(prompt, /search_workspace|list_workspace|indexed searches|architectural layers/);
	assert.match(prompt, /inspect_workspace verifies UTF-8 text/);
	assert.match(prompt, /edit_workspace requires path, exact oldText, and newText/);
	assert.match(prompt, /argv as an array/);
	assert.match(prompt, /correct the tool or arguments and retry/);
});

test("the orchestration module exposes a foreground bridge and keeps child capabilities depth-one", async () => {
	const delegatedTask = compileTask({ objective: "Delegate this task to subagents" });
	// Since harness modules phase 2, prompt words never enable delegation; the module does.
	assert.ok(!resolveCapabilities(delegatedTask).toolIds.includes("delegate_tasks"));
	const moduleTools = createOrchestrationModule().tools!;
	const delegated = resolveCapabilities(delegatedTask, undefined, [], [], { moduleTools });
	assert.ok(delegated.toolIds.includes("delegate_tasks"));
	assert.match(buildStableSystemPrompt(delegated.preset, delegated.toolIds, delegated.toolIds, { moduleTools }), /delegate_tasks.*nodes/);
	const childCapabilities = resolveCapabilities(delegatedTask, undefined, [], [], { moduleTools, delegationDepth: 1 });
	assert.ok(!childCapabilities.toolIds.includes("delegate_tasks"));

	const root = await temporaryDirectory("codetonomy-delegation-");
	const events: Array<{ type: string; data: Record<string, unknown> }> = [];
	// The parent (it has delegate_tasks) delegates two read-only children once; children answer.
	const sse = (delta: Record<string, unknown>, finish: string) => new Response([
		{ id: "d", object: "chat.completion.chunk", created: 1, model: "d-model", choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] },
		{ id: "d", object: "chat.completion.chunk", created: 1, model: "d-model", choices: [{ index: 0, delta: {}, finish_reason: finish }] },
	].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
	const providerFetch: typeof fetch = async (_input, init) => {
		const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string }>; tools?: Array<{ function?: { name?: string } }> };
		if (!body.tools?.some(({ function: fn }) => fn?.name === "delegate_tasks")) return sse({ content: "Child answer." }, "stop");
		if (body.messages?.some(({ role }) => role === "tool")) return sse({ content: "Delegated verified child work." }, "stop");
		return sse({ tool_calls: [{ index: 0, id: "d1", type: "function", function: { name: "delegate_tasks", arguments: JSON.stringify({ nodes: [
			{ id: "alpha", objective: "Say alpha", presetId: "general-assistant", permissionProfileId: "workspace-read" },
			{ id: "beta", objective: "Say beta", presetId: "general-assistant", permissionProfileId: "workspace-read" },
		] }) } }] }, "tool_calls");
	};
	const result = await createHarness().run({
		objective: "Answer the question using two helpers",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "d-provider",
		modelId: "d-model",
		providerConfiguration: { id: "d-provider", name: "Delegation", kind: "openai-compatible", baseUrl: "https://delegation.test/v1", apiKey: "d-key" },
		providerFetch,
		permissionMode: "auto",
		modules: [createOrchestrationModule()],
		observers: [(event) => { events.push({ type: event.type, data: event.data }); }],
	});
	assert.equal(result.verification.passed, true);
	assert.equal(events.filter(({ type }) => type === "subagent.requested").length, 2);
	assert.equal(events.filter(({ type }) => type === "subagent.completed").length, 2);
	const capabilityEvents = events.filter(({ type }) => type === "capabilities.resolved");
	assert.ok(capabilityEvents.some(({ data }) => {
		const capabilities = data.capabilities as { toolIds?: unknown } | undefined;
		return Array.isArray(capabilities?.toolIds) && capabilities.toolIds.includes("delegate_tasks");
	}));
	assert.ok(capabilityEvents.some(({ data }) => {
		const capabilities = data.capabilities as { toolIds?: unknown } | undefined;
		return Array.isArray(capabilities?.toolIds) && !capabilities.toolIds.includes("delegate_tasks");
	}));
	await assert.rejects(() => runHarnessOrchestration({
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		delegationDepth: 1,
		parentPermissionProfileId: "workspace-read",
		nodes: [{ id: "nested", objective: "Say no", presetId: "general-assistant", permissionProfileId: "workspace-read" }],
	}), /Recursive delegation is disabled/);
});

test("delegation remains approval-gated for read and write profiles", async () => {
	for (const profile of ["workspace-read", "workspace-write"] as const) {
		const gate = new PermissionGate(getPermissionProfile(profile), async () => true, [["delegate_tasks", "approval"]]);
		const decision = await gate.check({ toolId: "delegate_tasks", arguments: { nodes: [] }, riskClass: "low" });
		assert.equal(decision.decision, "ASK");
		assert.equal(decision.allowed, true);
	}
	// The module's tool runs real fixture children through the options its parent run supplies.
	const root = await temporaryDirectory("codetonomy-delegate-tool-");
	const run = (depth: number) => ({ depth, permissionProfileId: "workspace-read", inheritedOptions: { workspaceRoot: root, traceDirectory: join(root, "runs"), provider: "fixture", modelId: "faux-1", permissionMode: "auto" } });
	const tool = createOrchestrationModule().tools![0]!.create({ workspaceRoot: root, privatePaths: [], run: run(0) });
	const output = await tool.execute("delegation", {
		nodes: [{ id: "child", objective: "Do the bounded task", presetId: "general-assistant", permissionProfileId: "workspace-read" }],
	});
	assert.match(output.content[0]?.type === "text" ? output.content[0].text : "", /^Delegation verified: 1 of 1 children completed\.\n- child: completed \(run [0-9a-f-]{36}\)\n\n## child\n\n/);
	assert.match(output.content[0]?.type === "text" ? output.content[0].text : "", /Fixture agent completed: Do the bounded task/);
	await assert.rejects(
		tool.execute("invalid-preset", {
			nodes: [{ id: "child", objective: "Do the bounded task", presetId: "general", permissionProfileId: "workspace-read" }],
		}),
		/Unknown delegation preset.*general-assistant/,
	);
	// A read-only child cannot do write work, so the delegated result fails verification.
	await assert.rejects(
		tool.execute("failed-delegation", {
			nodes: [{ id: "child", objective: "Create out.txt containing exactly done", presetId: "general-assistant", permissionProfileId: "workspace-read" }],
		}),
		/failed verification/,
	);
	await assert.rejects(
		createOrchestrationModule().tools![0]!.create({ workspaceRoot: root, privatePaths: [], run: run(1) }).execute("nested", {
			nodes: [{ id: "child", objective: "Do the bounded task", presetId: "general-assistant", permissionProfileId: "workspace-read" }],
		}),
		/Recursive delegation is disabled/,
	);
});

test("skill manifests elevate the preset and fail closed on missing requirements", () => {
	const manifest = {
		id: "writer",
		version: "1.0.0",
		dependencies: [],
		conflicts: [],
		requiredCapabilities: [],
		requiredTools: ["write_workspace"],
		requiredPermissions: ["workspace-write"],
		verifierIds: ["workspace-change"],
	};
	const capabilities = resolveCapabilities(
		compileTask({ objective: "Research the current architecture" }),
		undefined,
		["writer"],
		[manifest],
	);
	assert.equal(capabilities.preset.id, "general-worker");
	assert.ok(capabilities.toolIds.includes("write_workspace"));
	assert.ok(capabilities.verifierIds.includes("workspace-change"));
	assert.throws(
		() => resolveCapabilities(compileTask({ objective: "Explain it" }), undefined, ["bad"], [{
			...manifest,
			id: "bad",
			requiredTools: ["unavailable_tool"],
		}]),
		/Missing tools/,
	);
});

test("workspace intent activates evidence requirements without an explicit @file", () => {
	const task = compileTask({ objective: "Please scan the codebase and summarize the architecture" });
	assert.ok(task.requiredCapabilities.includes("workspace-inspection"));
	assert.ok(task.acceptanceCriteria.some(({ id }) => id === "workspace-evidence"));
});

test("coding intent requests approved writes and verifies an actual mutation", async () => {
	const task = compileTask({ objective: "Implement a new status file" });
	assert.ok(task.requiredCapabilities.includes("workspace-write"));
	assert.equal(task.riskClass, "medium");
	const gate = new PermissionGate(getPermissionProfile("workspace-write"), async () => true);
	assert.equal((await gate.check({ toolId: "write_workspace", arguments: { path: "status.txt" }, riskClass: task.riskClass })).allowed, true);
	const denied = await new PermissionGate(getPermissionProfile("workspace-write")).check({
		toolId: "write_workspace",
		arguments: { path: "status.txt" },
		riskClass: task.riskClass,
	});
	assert.equal(denied.allowed, false);
	assert.equal(denied.decision, "ASK");
	assert.equal(verifyOutput("Implemented the status file.", undefined, {
		task,
		completedToolIds: ["list_workspace", "write_workspace"],
		fileEvidence: [{ target: "status.txt", action: "write", current: true, callId: "write-status" }],
	}).passed, true);
});

test("negated write intent stays read-only while a later affirmative clause still writes", () => {
	for (const objective of [
		"Inspect this project and explain it. Do not modify any files.",
		"Review only and don't fix anything",
		"Analyze the repository without making changes",
	]) {
		const task = compileTask({ objective });
		assert.ok(!task.requiredCapabilities.includes("workspace-write"), objective);
		assert.ok(!task.acceptanceCriteria.some(({ id }) => id === "workspace-change"), objective);
		assert.equal(task.riskClass, "low", objective);
	}
	for (const objective of [
		"Do not modify generated files; fix the parser",
		"Don't edit documentation, but update the tests",
	]) assert.ok(compileTask({ objective }).requiredCapabilities.includes("workspace-write"), objective);
});

test("command intent requires a successful approved native-sandbox run", async () => {
	const task = compileTask({ objective: "Run npm test" });
	assert.ok(task.requiredCapabilities.includes("workspace-command"));
	const gate = new PermissionGate(getPermissionProfile("workspace-write"), async () => true);
	assert.equal((await gate.check({ toolId: "run_workspace_command", arguments: { argv: ["npm", "test"] }, riskClass: task.riskClass })).allowed, true);
	assert.equal(verifyOutput("Tests passed.", undefined, {
		task,
		completedToolIds: ["list_workspace", "run_workspace_command"],
		commandExitCodes: [0],
		commandRuns: [{ argv: ["npm", "test"], exitCode: 0 }],
	}).passed, true);
	assert.equal(verifyOutput("Tests passed.", undefined, {
		task,
		completedToolIds: ["list_workspace", "run_workspace_command"],
		commandExitCodes: [1],
	}).passed, false);
});

test("command intent recognizes explicit package-manager and test invocations", () => {
	for (const objective of ["run npm test", "npm test", "npm run lint", "pnpm test", "yarn run build", "cargo test", "pytest", "python -m pytest"]) {
		assert.ok(compileTask({ objective }).requiredCapabilities.includes("workspace-command"), objective);
	}
	assert.ok(!compileTask({ objective: "Run the analysis" }).requiredCapabilities.includes("workspace-command"));
	const task = compileTask({ objective: "run npm test" });
	assert.equal(verifyOutput("npm test completed.", undefined, { task, commandExitCodes: [] }).passed, false);
	const wrongCommand = verifyOutput("npm test completed.", undefined, { task, commandExitCodes: [0], commandRuns: [{ argv: ["echo", "ok"], exitCode: 0 }] });
	assert.equal(wrongCommand.checks.find(({ id }) => id === "command-success")?.passed, false);
	const requestedCommand = verifyOutput("npm test completed.", undefined, { task, commandExitCodes: [0], commandRuns: [{ argv: ["npm", "run", "test"], exitCode: 0 }] });
	assert.equal(requestedCommand.checks.find(({ id }) => id === "command-success")?.passed, true);
});

test("aggregate token ceilings fail closed after provider usage crosses the limit", async () => {
	const root = await temporaryDirectory("codetonomy-spend-budget-");
	await assert.rejects(() => createHarness().run({ objective: "Say hello", workspaceRoot: root, provider: "fixture", modelId: "faux-1", maxTotalTokens: 0 }), /maxTotalTokens/);
	const result = await createHarness().run({
		objective: "Return a concise success response",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "fixture",
		modelId: "faux-1",
		maxTotalTokens: 1,
	});
	assert.ok(result.usage.totalTokens > 1);
	assert.equal(result.verification.passed, false);
	assert.match(result.verification.checks.map(({ message }) => message).join("\n"), /Aggregate token ceiling exceeded/);
});

test("activated skills stay in the turn tail and fingerprint the run", async () => {
	const root = await temporaryDirectory("agent-harness-skill-");
	const first = await createHarness().run({
		objective: "Apply the selected approach",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		activatedSkills: [{ id: "app-builder", instructions: "First skill revision" }],
	});
	const second = await createHarness().run({
		objective: "Apply the selected approach",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		activatedSkills: [{ id: "app-builder", instructions: "Second skill revision" }],
	});
	assert.equal(first.capabilities.cachePrefixHash, second.capabilities.cachePrefixHash);
	assert.notEqual(first.capabilities.runProfileHash, second.capabilities.runProfileHash);
	assert.deepEqual(first.capabilities.skillIds, ["app-builder"]);
	assert.match(first.output, /Activated skills: app-builder/);
	const trace = await readFile(first.tracePath, "utf8");
	assert.match(trace, /"activatedSkills":\[\{"id":"app-builder","contentHash":"[0-9a-f]{64}"\}\]/);
	assert.doesNotMatch(trace, /First skill revision/);
});

test("conversation history preserves the cache lane and fingerprints the run", async () => {
	const root = await temporaryDirectory("codetonomy-conversation-");
	const withoutHistory = await createHarness().run({
		objective: "Answer the follow-up",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
	});
	const withHistory = await createHarness().run({
		objective: "Answer the follow-up",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		sessionId: "session-1",
		conversation: [{ runId: "prior", objective: "What is this?", output: "A project.", timestamp: 1 }],
	});
	assert.equal(withoutHistory.capabilities.cachePrefixHash, withHistory.capabilities.cachePrefixHash);
	assert.notEqual(withoutHistory.capabilities.runProfileHash, withHistory.capabilities.runProfileHash);
	assert.match(await readFile(withHistory.tracePath, "utf8"), /"conversationTurns":1/);
});

test("conversation projection keeps a bounded recent tail without changing canonical history", () => {
	const turns = Array.from({ length: 5 }, (_, index) => ({
		runId: `run-${index}`,
		objective: `Question ${index}`,
		output: "x".repeat(100),
		timestamp: index,
	}));
	const projection = projectConversation(turns, 500, 3);
	assert.deepEqual(projection.turns.map(({ runId }) => runId), ["run-3", "run-4"]);
	assert.equal(projection.omittedTurns, 3);
	assert.equal(turns.length, 5);
	assert.match(projection.projectionHash, /^[0-9a-f]{64}$/);
	assert.notEqual(projectConversation(turns).projectionHash, projectConversation(turns.map(turn => ({ ...turn, prompt: `${turn.objective}\nRendered context` }))).projectionHash);
});

test("session cache diagnostics report configuration changes without claiming provider hits", async () => {
	const root = await temporaryDirectory("codetonomy-cache-shape-");
	const run = () => createHarness().run({
		objective: "Answer this",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		sessionId: "stable-session",
	});
	const first = await run();
	const second = await run();
	assert.match(await readFile(first.tracePath, "utf8"), /"status":"new"/);
	assert.match(await readFile(second.tracePath, "utf8"), /"scope":"prefix-configuration"/);
	assert.match(await readFile(second.tracePath, "utf8"), /"status":"unchanged"/);
	if (process.platform !== "win32") {
		assert.equal((await stat(first.tracePath)).mode & 0o077, 0);
		assert.equal((await stat(join(first.tracePath, "..", "result.json"))).mode & 0o077, 0);
	}
	const changed = await createHarness().run({
		objective: "Research this topic", presetId: "general-assistant",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		sessionId: "stable-session",
	});
	const changedTrace = await readFile(changed.tracePath, "utf8");
	assert.match(changedTrace, /"type":"cache.invalidated"/);
	// The default general-worker bundle is workspace-write, so the read-only general-assistant changes both.
	assert.match(changedTrace, /"changed":\["tools","permission"\]/);
});

test("fixture runtime executes a permission-gated tool and writes a complete trace", async () => {
	const root = await temporaryDirectory("agent-harness-");
	const traceDirectory = join(root, "runs");
	await writeFile(join(root, "evidence.txt"), "revenue grew 12%", "utf8");
	await writeFile(join(root, "context.txt"), "costs fell 4%", "utf8");
	const streamed: string[] = [];
	const result = await createHarness().run({
		objective: "Summarize the evidence",
		files: [join(root, "evidence.txt"), join(root, "context.txt")],
		workspaceRoot: root,
		traceDirectory,
		observers: [() => { throw new Error("passive observer failure"); }],
		onStream: ({ text }) => streamed.push(text),
	});

	assert.equal(result.verification.passed, true);
	assert.match(result.output, /revenue grew 12%/);
	assert.match(result.output, /costs fell 4%/);
	assert.ok(streamed.length > 1);
	assert.match(streamed.at(-1) ?? "", /revenue grew 12%/);
	const trace = (await readFile(result.tracePath, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { eventId: string; parentEventId?: string; type: string; sequence: number });
	const types = trace.map(({ type }) => type);
	for (const required of [
		"run.started",
		"task.compiled",
		"capabilities.resolved",
		"model.request.started",
		"tool.requested",
		"tool.allowed",
		"tool.started",
		"tool.completed",
		"verification.completed",
		"run.completed",
	]) {
		assert.ok(types.includes(required), `missing ${required}`);
	}
	assert.deepEqual(trace.map(({ sequence }) => sequence), trace.map((_, index) => index + 1));
	assert.ok(trace.slice(1).every(({ parentEventId }) => parentEventId), "every non-root event must have a parent");
	assert.equal(types.filter((type) => type === "model.first_token").length, 2);
	assert.equal(types.filter((type) => type === "tool.completed").length, 2);
	for (const [before, after] of [
		["model.request.completed", "tool.requested"],
		["tool.requested", "tool.allowed"],
		["tool.allowed", "tool.started"],
		["tool.started", "tool.completed"],
	] as const) {
		assert.ok(types.indexOf(before) < types.indexOf(after), `${before} must precede ${after}`);
	}
	assert.ok(result.usage.totalTokens > 0);
	assert.equal(typeof result.usage.cacheSavingsRatio, "number");
	assert.equal(typeof result.usage.cost?.total, "number");
	assert.match(await readFile(result.tracePath, "utf8"), /"durationMs":/);
});

test("permissionMode auto approves known ASK tools while ask remains fail-closed", async () => {
	const root = await temporaryDirectory("codetonomy-permission-mode-");
	const providerFetch = (): typeof fetch => {
		let requestCount = 0;
		return async () => {
			requestCount++;
			const base = { id: `permission-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "permission-model" };
			const events = requestCount === 1
				? [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "permission-list", type: "function", function: { name: "list_workspace", arguments: '{"path":"."}' } }] }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
				]
				: requestCount === 2
				? [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "permission-write", type: "function", function: { name: "write_workspace", arguments: '{"path":"status.txt","content":"done"}' } }] }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
				]
				: [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Wrote status.txt." }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
				];
			return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		};
	};
	const run = (permissionMode: "ask" | "auto") => createHarness().run({
		objective: "Implement a new status file",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "permission-provider",
		modelId: "permission-model",
		providerConfiguration: {
			id: "permission-provider",
			name: "Permission Provider",
			kind: "openai-compatible",
			baseUrl: "https://provider.test/v1",
			apiKey: "test-key",
		},
		providerFetch: providerFetch(),
		permissionMode,
	});
	const ask = await run("ask");
	assert.equal(ask.verification.passed, false);
	assert.equal(await stat(join(root, "status.txt")).then(() => true, () => false), false);
	const automatic = await run("auto");
	assert.equal(automatic.verification.passed, true);
	assert.equal(await readFile(join(root, "status.txt"), "utf8"), "done");
});

test("workspace inspection refuses link escapes", async () => {
	const root = await temporaryDirectory("agent-harness-root-");
	const outside = await temporaryDirectory("agent-harness-outside-");
	await mkdir(join(root, "links"));
	await writeFile(join(outside, "secret.txt"), "secret", "utf8");
	await symlink(outside, join(root, "links", "outside"), process.platform === "win32" ? "junction" : "dir");
	const tool = inspectWorkspaceTool(root);
	await assert.rejects(() => tool.execute("call", { path: "links/outside/secret.txt" }), /outside the workspace/);
});

test("workspace discovery lists files and searches code without following ignored or escaped paths", async () => {
	const root = await temporaryDirectory("codetonomy-discovery-");
	const outside = await temporaryDirectory("codetonomy-discovery-outside-");
	await mkdir(join(root, "src"), { recursive: true });
	await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
	const indexedSource = `${"irrelevant prefix ".repeat(30)}\nexport const mascot = 'polar bear semantic indexed result';\n${"irrelevant suffix ".repeat(30)}\n`;
	await writeFile(join(root, "src", "agent.ts"), indexedSource, "utf8");
	await writeFile(join(root, ".env"), "POLAR_BEAR_API_KEY=never-expose-this", "utf8");
	await writeFile(join(root, "secrets.json"), '{"token":"polar bear credential"}', "utf8");
	await mkdir(join(root, ".ssh"));
	await writeFile(join(root, ".ssh", "id_ed25519"), "polar bear private key", "utf8");
	await writeFile(join(root, "node_modules", "ignored", "secret.ts"), "polar bear secret", "utf8");
	await writeFile(join(outside, "outside.ts"), "polar bear outside", "utf8");
	await symlink(outside, join(root, "escaped"), process.platform === "win32" ? "junction" : "dir");

	const listed = await listWorkspaceTool(root).execute("list", { path: ".", depth: 2, limit: 100 });
	const listText = listed.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
	assert.match(listText, /src\/agent\.ts/);
	assert.doesNotMatch(listText, /node_modules|escaped|\.env|secrets\.json|\.ssh/);
	await mkdir(join(root, ".codetonomy"));
	await writeFile(join(root, ".codetonomy", "credentials.env"), "API_KEY=secret", "utf8");
	await assert.rejects(() => inspectWorkspaceTool(root).execute("protected", { path: ".codetonomy/credentials.env" }), /protected/);
	await assert.rejects(() => inspectWorkspaceTool(root).execute("sensitive", { path: ".env" }), /Sensitive workspace paths/);
	await assert.rejects(() => writeWorkspaceTool(root).execute("sensitive-write", { path: ".env.local", content: "SECRET=bad" }), /Sensitive workspace paths/);
	// macOS and Linux hide secret files inside the sandbox by pattern; Windows still refuses the command.
	const sensitiveCommand = () => runWorkspaceCommandTool(root, { sandboxBinary: process.execPath, outputStore: commandOutputStore(root) }).execute("sensitive-command", { argv: ["ignored"] });
	if (secretFileDenyEntries(await realpath(root))) await sensitiveCommand();
	else await assert.rejects(sensitiveCommand, /commands are blocked.*sensitive path/);

	const searched = await searchWorkspaceTool(root).execute("search", { query: "polar bear" });
	const searchText = searched.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
	assert.match(searchText, /src\/agent\.ts:2/);
	assert.doesNotMatch(searchText, /never-expose|credential|private key|outside/);
	const virtualSearch = await searchWorkspaceTool(root).execute("virtual-search", { query: "polar bear", path: "/workspace/src" });
	assert.match(virtualSearch.content[0]?.type === "text" ? virtualSearch.content[0].text : "", /src\/agent\.ts:2/);
	const virtualInspect = await inspectWorkspaceTool(root).execute("virtual-inspect", { path: "/workspace/src/agent.ts", offset: 2, limit: 1 });
	assert.match(virtualInspect.content[0]?.type === "text" ? virtualInspect.content[0].text : "", /polar bear semantic indexed result/);
	await assert.rejects(() => listWorkspaceTool(root).execute("escape", { path: "../" }), /outside the workspace/);
});

test("workspace writes are atomic, exact, and confined to the workspace", async () => {
	const root = await temporaryDirectory("codetonomy-write-");
	const outside = await temporaryDirectory("codetonomy-write-outside-");
	await mkdir(join(root, "src"), { recursive: true });
	await writeWorkspaceTool(root).execute("write", { path: "src/app.ts", content: "const state = 'old';\n" });
	assert.equal(await readFile(join(root, "src", "app.ts"), "utf8"), "const state = 'old';\n");
	await writeWorkspaceTool(root).execute("virtual-write", { path: "/workspace/src/virtual.ts", content: "export {};\n" });
	assert.equal(await readFile(join(root, "src", "virtual.ts"), "utf8"), "export {};\n");
	await editWorkspaceTool(root).execute("edit", { path: "src/app.ts", oldText: "'old'", newText: "'new'" });
	assert.equal(await readFile(join(root, "src", "app.ts"), "utf8"), "const state = 'new';\n");
	await writeFile(join(root, "ambiguous.txt"), "same same", "utf8");
	await assert.rejects(
		() => editWorkspaceTool(root).execute("ambiguous", { path: "ambiguous.txt", oldText: "same", newText: "new" }),
		/2 locations/,
	);
	await symlink(outside, join(root, "escaped-write"), process.platform === "win32" ? "junction" : "dir");
	await assert.rejects(() => writeWorkspaceTool(root).execute("escape", { path: "escaped-write/output.txt", content: "secret" }), /outside the workspace/);
	await assert.rejects(
		() => writeWorkspaceTool(root).execute("escape", { path: "../secret.txt", content: "secret" }),
		/outside the workspace/,
	);
});

test("workspace commands use argv-only Codetonomy sandboxing and propagate cancellation", async () => {
	const root = await temporaryDirectory("codetonomy-command-");
	const invocation = createSandboxInvocation(root, ["npm", "test"]);
	assert.deepEqual(invocation.slice(-3), ["--", "npm", "test"]);
	const state = JSON.parse(invocation[2]!) as {
		permissionProfile: { network: string; file_system: { entries: Array<{ access: string; path: { type: string; value?: { kind?: string } } }> } };
		sandboxCwd: string;
	};
	assert.equal(state.permissionProfile.network, "restricted");
	assert.ok(state.permissionProfile.file_system.entries.some(({ access, path }) => access === "write" && path.value?.kind === "project_roots"));
	assert.match(state.sandboxCwd, /^file:/);
	assert.deepEqual(filterSandboxEnvironment({ PATH: "/bin", LANG: "C", OPENAI_API_KEY: "secret", CUSTOM_TOKEN: "secret" }), { PATH: "/bin", LANG: "C" });

	const shim = join(root, "sandbox");
	await writeFile(shim, "setInterval(() => {}, 1000);\n", "utf8");
	const abort = new AbortController();
	const execution = runWorkspaceCommandTool(root, { sandboxBinary: process.execPath, outputStore: commandOutputStore(root) }).execute("run", { argv: ["npm", "test"], timeoutSeconds: 30 }, abort.signal);
	setTimeout(() => abort.abort(), 20);
	await assert.rejects(() => execution, /aborted/);
});

test("workspace command checkpoints restore edited and newly created files", async () => {
	const root = await temporaryDirectory("codetonomy-command-checkpoint-");
	await writeFile(join(root, "existing.txt"), "before", "utf8");
	const shim = join(root, "sandbox");
	await writeFile(shim, "const fs = require('node:fs'); fs.writeFileSync('existing.txt', 'after'); fs.writeFileSync('created.txt', 'new');\n", "utf8");
	const checkpointPath = join(root, ".harness", "command.json");
	const checkpoint = new RunCheckpoint(root, "command-run", checkpointPath);
	const result = await runWorkspaceCommandTool(root, { sandboxBinary: process.execPath, observer: checkpoint, outputStore: commandOutputStore(root) }).execute("run", { argv: ["ignored"] });
	assert.equal((result.details as { rewindCoverage?: string }).rewindCoverage, "incomplete");
	assert.deepEqual((await previewCheckpoint(checkpointPath, root)).files, ["existing.txt", "created.txt"]);
	await rewindCheckpoint(checkpointPath, root);
	assert.equal(await readFile(join(root, "existing.txt"), "utf8"), "before");
	await assert.rejects(() => readFile(join(root, "created.txt"), "utf8"), { code: "ENOENT" });
});

test("workspace command checkpoints cover projects larger than the former 5000-file boundary", async () => {
	const root = await temporaryDirectory("codetonomy-large-checkpoint-");
	await mkdir(join(root, "src"));
	for (let start = 0; start < 5_100; start += 250) {
		await Promise.all(Array.from({ length: Math.min(250, 5_100 - start) }, (_, offset) => writeFile(join(root, "src", `${start + offset}.txt`), "")));
	}
	const checkpointPath = join(root, ".harness", "large.json");
	const checkpoint = new RunCheckpoint(root, "large-run", checkpointPath);
	await checkpoint.beforeWorkspace();
	await writeFile(join(root, "src", "5099.txt"), "changed");
	await checkpoint.afterWorkspace();
	assert.deepEqual((await previewCheckpoint(checkpointPath, root)).files, [join("src", "5099.txt")]);
});

test("durable checkpoints restore approved edits and reject later manual changes", async () => {
	const root = await temporaryDirectory("codetonomy-checkpoint-");
	const checkpointPath = join(root, ".harness", "checkpoint.json");
	await writeFile(join(root, "existing.txt"), "before", "utf8");
	const checkpoint = new RunCheckpoint(root, "run-1", checkpointPath);
	await writeWorkspaceTool(root, checkpoint).execute("edit-existing", { path: "existing.txt", content: "after" });
	await writeWorkspaceTool(root, checkpoint).execute("create-new", { path: "new.txt", content: "new" });
	assert.equal(checkpoint.path, checkpointPath);
	assert.equal(await readFile(join(root, "existing.txt"), "utf8"), "after");
	const preview = await previewCheckpoint(checkpointPath, root);
	assert.deepEqual(preview.files, ["existing.txt", "new.txt"]);
	assert.match(preview.diff, /-before[\s\S]*\+after/);
	const rewound = await rewindCheckpoint(checkpointPath, root);
	assert.deepEqual(rewound, { restored: ["existing.txt"], deleted: ["new.txt"], coverage: "captured", residual: [] });
	assert.equal(await readFile(join(root, "existing.txt"), "utf8"), "before");
	await assert.rejects(() => readFile(join(root, "new.txt"), "utf8"), { code: "ENOENT" });

	const conflictingPath = join(root, ".harness", "conflict.json");
	const conflict = new RunCheckpoint(root, "run-2", conflictingPath);
	await writeWorkspaceTool(root, conflict).execute("edit", { path: "existing.txt", content: "codetonomy" });
	await writeFile(join(root, "existing.txt"), "manual", "utf8");
	await assert.rejects(() => rewindCheckpoint(conflictingPath, root), /changed after Codetonomy/);
	assert.equal(await readFile(join(root, "existing.txt"), "utf8"), "manual");
});

test("workspace inspection rejects oversized and invalid UTF-8 files", async () => {
	const root = await temporaryDirectory("agent-harness-input-");
	const tool = inspectWorkspaceTool(root);
	await writeFile(join(root, "large.txt"), Buffer.alloc(2 * 1024 * 1024 + 1));
	await writeFile(join(root, "binary.txt"), Buffer.from([0xff]));
	await writeFile(join(root, "original.txt"), "linked", "utf8");
	await link(join(root, "original.txt"), join(root, "linked.txt"));
	await assert.rejects(() => tool.execute("large", { path: "large.txt" }), /exceeds/);
	await assert.rejects(() => tool.execute("binary", { path: "binary.txt" }), /valid/i);
	await assert.rejects(() => tool.execute("linked", { path: "linked.txt" }), /Hard-linked/);
});

test("verification rejects refusals and workspace answers without evidence", () => {
	const task = compileTask({ objective: "Scan the codebase" });
	const refusal = verifyOutput("I don't have access to file tools. Please provide the codebase.", undefined, { task });
	assert.equal(refusal.passed, false);
	assert.equal(refusal.checks.find(({ id }) => id === "agent-completed-task")?.passed, false);
	const unsupported = verifyOutput("The project looks healthy.", undefined, { task });
	assert.equal(unsupported.checks.find(({ id }) => id === "workspace-evidence")?.passed, false);
	const supported = verifyOutput("The project contains a runtime and CLI.", undefined, {
		task,
		completedToolIds: ["list_workspace"],
	});
	assert.equal(supported.passed, true);
});

test("permission ASK and DENY decisions fail closed without approval", async () => {
	for (const decision of ["ASK", "DENY"] as const) {
		const gate = new PermissionGate({ id: decision, defaultDecision: decision, toolDecisions: {} });
		const result = await gate.check({ toolId: "unknown", arguments: {}, riskClass: "high" });
		assert.equal(result.allowed, false);
		assert.equal(result.decision, decision);
	}
	const fullLike = new PermissionGate({ id: "deny", defaultDecision: "DENY", toolDecisions: {} }, async () => true);
	assert.equal((await fullLike.check({ toolId: "unknown", arguments: {}, riskClass: "high" })).allowed, false);
});

test("tool failures fail verification and the run", async () => {
	const root = await temporaryDirectory("agent-harness-failure-");
	const result = await createHarness().run({
		objective: "Read missing evidence",
		files: [join(root, "missing.txt")],
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
	});
	assert.equal(result.verification.passed, false);
	const trace = await readFile(result.tracePath, "utf8");
	assert.match(trace, /"type":"tool.failed"/);
	assert.match(trace, /"type":"run.failed"/);
});

test("an already-aborted run stops before model execution", async () => {
	const root = await temporaryDirectory("agent-harness-abort-");
	const abortController = new AbortController();
	abortController.abort();
	await assert.rejects(
		() => createHarness().run({
			objective: "Do not start",
			workspaceRoot: root,
			traceDirectory: join(root, "runs"),
			signal: abortController.signal,
		}),
		/Run aborted/,
	);
});

test("an OpenAI-compatible provider receives tools and completes a real tool round-trip", async () => {
	const root = await temporaryDirectory("codetonomy-custom-provider-");
	await writeFile(join(root, "README.md"), "# Local project\n", "utf8");
	const requests: Array<Record<string, unknown>> = [];
	const providerFetch: typeof fetch = async (_input, init) => {
		requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		const base = { id: `chat-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "coder-model" };
		const events = requests.length === 1
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "list_workspace", arguments: '{"path":".","depth":1}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "The workspace contains README.md." }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	let savedPrompt = "";
	const options = {
			objective: "Scan the codebase and summarize it",
			presetId: "general-assistant",
			onUserPrompt: (prompt: string) => { savedPrompt = prompt; },
			activatedSkills: [{ id: "retained-skill", instructions: "PROMPT_RETAINED_ONLY_IN_PRIVATE_SESSION" }],
			workspaceRoot: root,
			traceDirectory: join(root, "runs"),
			provider: "local-llm",
			modelId: "coder-model",
			providerConfiguration: {
				id: "local-llm",
				name: "Local LLM",
				kind: "openai-compatible" as const,
				baseUrl: "https://provider.test/v1",
				apiKey: "test-key",
			},
			providerFetch,
		};
	const result = await createHarness().run(options);
	assert.equal(result.verification.passed, true);
	assert.match(result.output, /README\.md/);
	assert.equal(requests.length, 2);
	const tools = requests[0]?.tools as Array<{ function?: { name?: string } }>;
	assert.ok(tools.some(({ function: definition }) => definition?.name === "list_workspace"));
	const messages = requests[1]?.messages as Array<{ role?: string }>;
	assert.ok(messages.some(({ role }) => role === "tool"));
	const firstPrompt = savedPrompt;
	assert.match(firstPrompt, /runtime-permissions/);
	assert.match(firstPrompt, /PROMPT_RETAINED_ONLY_IN_PRIVATE_SESSION/);
	assert.doesNotMatch(await readFile(result.tracePath, "utf8"), /PROMPT_RETAINED_ONLY_IN_PRIVATE_SESSION/);
	assert.doesNotMatch(JSON.stringify(result), /PROMPT_RETAINED_ONLY_IN_PRIVATE_SESSION/);
	const resumed = await createHarness().run({ ...options, objective: "What was the answer again?", conversation: [{ runId: result.runId, objective: options.objective, prompt: firstPrompt, output: result.output, timestamp: 1 }] });
	assert.equal(resumed.verification.passed, true, JSON.stringify(resumed.verification));
	assert.equal(requests.length, 3);
	assert.deepEqual(requests[2]?.tools, requests[0]?.tools);
	assert.deepEqual((requests[2]?.messages as unknown[]).slice(0, 2), requests[0]?.messages);
	await createHarness().run({ ...options, objective: "What was the answer again?", conversation: [{ runId: result.runId, objective: options.objective, output: result.output, timestamp: 1 }] });
	assert.equal((requests[3]?.messages as Array<{ content: unknown }>)[1]?.content, options.objective);
});

test("a successful retry of the same tool clears a recoverable tool failure", async () => {
	const root = await temporaryDirectory("codetonomy-tool-recovery-");
	await writeFile(join(root, "README.md"), "# Recovery fixture\n", "utf8");
	let requestCount = 0;
	const providerFetch: typeof fetch = async () => {
		requestCount++;
		const base = { id: `recovery-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "recovery-model" };
		const choices = requestCount === 1
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "recovery-missing", type: "function", function: { name: "inspect_workspace", arguments: '{"path":"missing.txt"}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: requestCount === 2
				? [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "recovery-corrected", type: "function", function: { name: "inspect_workspace", arguments: '{"path":"README.md"}' } }] }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
				]
				: [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "The workspace contains README.md." }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
				];
		return new Response(`${choices.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await createHarness().run({
		objective: "Scan the codebase",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "recovery-provider",
		modelId: "recovery-model",
		providerConfiguration: {
			id: "recovery-provider",
			name: "Recovery Provider",
			kind: "openai-compatible",
			baseUrl: "https://provider.test/v1",
			apiKey: "test-key",
		},
		providerFetch,
	});
	assert.equal(result.verification.passed, true);
	assert.equal(requestCount, 3);
});

test("repeated unknown tools are traced and stop after the correctable limit without verifier repair", async () => {
	const root = await temporaryDirectory("codetonomy-unknown-tool-");
	let requestCount = 0;
	const providerFetch: typeof fetch = async () => {
		requestCount++;
		const base = { id: `unknown-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "unknown-model" };
		const events = [
			{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "unknown-read", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } }] }, finish_reason: null }] },
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
		];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await createHarness().run({
		objective: "Read README.md",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "unknown-provider",
		modelId: "unknown-model",
		providerConfiguration: {
			id: "unknown-provider",
			name: "Unknown Provider",
			kind: "openai-compatible",
			baseUrl: "https://provider.test/v1",
			apiKey: "test-key",
		},
		providerFetch,
	});
	assert.equal(requestCount, 3);
	assert.equal(result.verification.passed, false);
	assert.equal(result.verification.checks.find(({ id }) => id === "runtime-complete")?.message, "Unknown tool called 3 times; last was read_file");
	const trace = await readFile(result.tracePath, "utf8");
	assert.match(trace, /"type":"tool.requested".*"toolId":"read_file"/);
	assert.match(trace, /"type":"tool.failed".*"message":"Tool read_file not found"/);
});

test("a parallel same-tool success does not hide a failed call", async () => {
	const root = await temporaryDirectory("codetonomy-tool-parallel-failure-");
	await writeFile(join(root, "README.md"), "# Parallel fixture\n", "utf8");
	let requestCount = 0;
	const providerFetch: typeof fetch = async () => {
		requestCount++;
		const base = { id: `parallel-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "parallel-model" };
		const choices = requestCount === 1
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [
					{ index: 0, id: "parallel-missing", type: "function", function: { name: "inspect_workspace", arguments: '{"path":"missing.txt"}' } },
					{ index: 1, id: "parallel-present", type: "function", function: { name: "inspect_workspace", arguments: '{"path":"README.md"}' } },
				] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "The workspace contains README.md." }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			];
		return new Response(`${choices.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await createHarness().run({
		objective: "Scan the codebase",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "parallel-provider",
		modelId: "parallel-model",
		providerConfiguration: {
			id: "parallel-provider",
			name: "Parallel Provider",
			kind: "openai-compatible",
			baseUrl: "https://provider.test/v1",
			apiKey: "test-key",
		},
		providerFetch,
	});
	assert.equal(result.verification.passed, false);
	assert.ok(result.verification.checks.some(({ id, passed }) => id === "runtime-complete" && !passed));
});

test("max-output is terminal and does not enter generic verification repair", async () => {
	const root = await temporaryDirectory("codetonomy-max-output-terminal-");
	await writeFile(join(root, "README.md"), "# Read-only fixture\n", "utf8");
	let requestCount = 0;
	const providerFetch: typeof fetch = async () => {
		requestCount++;
		const base = { id: `max-output-terminal-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "max-output-model" };
		const events = requestCount === 1
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "inspect-read-only", type: "function", function: { name: "list_workspace", arguments: '{"path":".","depth":1}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Partial inspection answer" }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
			];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await createHarness().run({
		objective: "Inspect the project and explain it",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "max-output-provider",
		modelId: "max-output-model",
		providerConfiguration: { id: "max-output-provider", name: "Max Output Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
	});
	assert.equal(requestCount, 2);
	assert.equal(result.verification.passed, false);
	assert.match(result.verification.checks.find(({ id }) => id === "runtime-complete")?.message ?? "", /^Model output limit reached \(\d+ tokens\)$/);
	const trace = await readFile(result.tracePath, "utf8");
	assert.match(trace, /"outcome":"max-output"/);
	assert.match(trace, /"actionNudgeIssued":false/);
	assert.match(trace, /"proactiveActionNudgeIssued":false/);
	assert.match(trace, /"truncationActionNudgeIssued":false/);
});

test("a first-turn truncation gets one discovery retry under the model limit", async (t) => {
	if (skipWithoutRipgrep(t)) return;
	const root = await temporaryDirectory("codetonomy-first-turn-rescue-");
	await writeFile(join(root, "README.md"), "# Indexed project\n", "utf8");
	const requests: Array<Record<string, unknown>> = [];
	const providerFetch: typeof fetch = async (_input, init) => {
		requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		const base = { id: `first-turn-rescue-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "rescue-model" };
		const events = requests.length === 1
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "I will plan this carefully." }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
			]
			: requests.length === 2
				? [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "rescue-search", type: "function", function: { name: "bash", arguments: '{"command":"rg -nF Indexed README.md"}' } }] }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
				]
				: requests.length === 3
					? [
						{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "rescue-write", type: "function", function: { name: "bash", arguments: '{"command":"printf \'done\\\\n\' > status.txt"}' } }] }, finish_reason: null }] },
						{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
					]
					: [
						{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Implemented status.txt." }, finish_reason: null }] },
						{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
					];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await createHarness().run({
		objective: "Implement a status file in this project",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "first-turn-rescue-provider",
		modelId: "rescue-model",
		permissionMode: "auto",
		providerConfiguration: { id: "first-turn-rescue-provider", name: "First-turn rescue", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
		toolInterface: "bash",
	});
	assert.equal(result.verification.passed, true);
	assert.equal(await readFile(join(root, "status.txt"), "utf8"), "done\n");
	assert.equal(requests.length, 4);
	assert.ok(requests.every(request => Number(request.max_tokens ?? request.max_completion_tokens) > 12_000 && Number(request.max_tokens ?? request.max_completion_tokens) <= 128_000));
	const retryUsers = (requests[1]?.messages as Array<{ role?: string; content?: unknown }>).filter(({ role }) => role === "user");
	assert.ok(retryUsers.some(({ content }) => JSON.stringify(content).includes("must call bash")));
});

test("official DeepSeek continues one truncated prefix before issuing an executor nudge", async () => {
	const root = await temporaryDirectory("codetonomy-deepseek-prefix-");
	await writeFile(join(root, "README.md"), "# Prefix fixture\n", "utf8");
	const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
	const providerFetch: typeof fetch = async (input, init) => {
		const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		requests.push({ url, body });
		const base = { id: `deepseek-prefix-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "deepseek-v4-flash" };
		const events = requests.length === 1
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "prefix-inspect", type: "function", function: { name: "list_workspace", arguments: '{"path":".","depth":1}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: requests.length === 2
				? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "I inspected the project and will now " }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "apply" }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
			]
			: requests.length === 3
				? [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "prefix-write", type: "function", function: { name: "write_workspace", arguments: '{"path":"status.txt","content":"done\\n"}' } }] }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
				]
				: [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Implemented status.txt." }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
				];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await createHarness().run({
		objective: "Implement a status file in this project",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "deepseek",
		modelId: "deepseek-v4-flash",
		permissionMode: "auto",
		providerConfiguration: { id: "deepseek", name: "DeepSeek", kind: "deepseek", apiKey: "test-key" },
		providerFetch,
	});
	assert.equal(result.verification.passed, true);
	assert.equal(await readFile(join(root, "status.txt"), "utf8"), "done\n");
	assert.equal(requests.length, 4);
	assert.match(requests[0]!.url, /\/chat\/completions$/);
	assert.match(requests[1]!.url, /\/chat\/completions$/);
	assert.match(requests[2]!.url, /\/beta\/chat\/completions$/);
	const prefixMessages = requests[2]!.body.messages as Array<{ role: string; content?: unknown; prefix?: boolean }>;
	assert.equal(prefixMessages.at(-1)?.role, "assistant");
	assert.equal(prefixMessages.at(-1)?.prefix, true);
	assert.doesNotMatch(JSON.stringify(prefixMessages), /Continue the preceding response/);
	assert.match(requests[3]!.url, /\/chat\/completions$/);
});

test("a discovery loop gets one preemptive action reminder before the fifth turn", async () => {
	const root = await temporaryDirectory("codetonomy-action-nudge-preemptive-");
	await writeFile(join(root, "README.md"), "# Preemptive fixture\n", "utf8");
	let requestCount = 0;
	const requests: Array<Record<string, unknown>> = [];
	const providerFetch: typeof fetch = async (_input, init) => {
		requestCount++;
		requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		const base = { id: `action-nudge-preemptive-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "action-model" };
		const events = requestCount <= 4
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `inspect-${requestCount}`, type: "function", function: { name: "list_workspace", arguments: '{"path":".","depth":1}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: requestCount === 5
				? [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "write-after-preemptive-nudge", type: "function", function: { name: "write_workspace", arguments: '{"path":"status.txt","content":"done\\n"}' } }] }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
				]
				: [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Implemented status.txt." }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
				];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const events: Array<{ type: string; data: Record<string, unknown> }> = [];
	const result = await createHarness().run({
		objective: "Implement a status file in this project",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "preemptive-action-provider",
		modelId: "action-model",
		permissionMode: "auto",
		providerConfiguration: { id: "preemptive-action-provider", name: "Preemptive Action Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
		observers: [(event) => { events.push({ type: event.type, data: event.data }); }],
	});
	assert.equal(requestCount, 6);
	assert.equal(result.verification.passed, true);
	assert.equal(await readFile(join(root, "status.txt"), "utf8"), "done\n");
	const fifthTurnUsers = (requests[4]?.messages as Array<{ role?: string; content?: unknown }> | undefined)?.filter(({ role }) => role === "user") ?? [];
	assert.ok(fifthTurnUsers.some(({ content }) => JSON.stringify(content).includes("repeating workspace discovery")));
	const completed = events.filter(({ type }) => type === "model.request.completed");
	assert.deepEqual(completed.map(({ data }) => data.actionNudge), [false, false, false, false, true, false]);
	assert.deepEqual(completed.map(({ data }) => data.actionNudgeTrigger), [undefined, undefined, undefined, undefined, "proactive", undefined]);
	assert.equal(events.find(({ type }) => type === "run.completed")?.data.actionNudgeAttempts, 1);
	assert.equal(events.find(({ type }) => type === "run.completed")?.data.proactiveActionNudgeIssued, true);
	assert.equal(events.find(({ type }) => type === "run.completed")?.data.truncationActionNudgeIssued, false);
	assert.equal(events.find(({ type }) => type === "run.completed")?.data.modelOutputTruncations, 0);
});

test("a discovery reminder can be followed by a separate truncation rescue", async () => {
	const root = await temporaryDirectory("codetonomy-action-nudge-two-stage-");
	await writeFile(join(root, "README.md"), "# Two-stage fixture\n", "utf8");
	let requestCount = 0;
	const requests: Array<Record<string, unknown>> = [];
	const providerFetch: typeof fetch = async (_input, init) => {
		requestCount++;
		requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		const base = { id: `action-nudge-two-stage-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "action-model" };
		const events = requestCount <= 4
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `inspect-${requestCount}`, type: "function", function: { name: "list_workspace", arguments: '{"path":".","depth":1}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: requestCount === 5
				? [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "I will keep planning." }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
				]
				: requestCount === 6
					? [
						{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "write-after-rescue", type: "function", function: { name: "write_workspace", arguments: '{"path":"status.txt","content":"done\\n"}' } }] }, finish_reason: null }] },
						{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
					]
						: [
							{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Implemented status.txt." }, finish_reason: null }] },
							{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
						];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const events: Array<{ type: string; data: Record<string, unknown> }> = [];
	const result = await createHarness().run({
		objective: "Implement a status file in this project",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "two-stage-action-provider",
		modelId: "action-model",
		permissionMode: "auto",
		providerConfiguration: { id: "two-stage-action-provider", name: "Two-stage Action Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
		observers: [(event) => { events.push({ type: event.type, data: event.data }); }],
	});
	assert.equal(requestCount, 7);
	assert.equal(result.verification.passed, true);
	assert.equal(await readFile(join(root, "status.txt"), "utf8"), "done\n");
	const completed = events.filter(({ type }) => type === "model.request.completed");
	assert.deepEqual(completed.filter(({ data }) => data.actionNudge).map(({ data }) => data.actionNudgeTrigger), ["proactive", "truncation"]);
	assert.equal(events.find(({ type }) => type === "run.completed")?.data.actionNudgeAttempts, 2);
	assert.equal(events.find(({ type }) => type === "run.completed")?.data.proactiveActionNudgeIssued, true);
	assert.equal(events.find(({ type }) => type === "run.completed")?.data.truncationActionNudgeIssued, true);
	assert.equal(events.find(({ type }) => type === "run.completed")?.data.modelOutputTruncations, 1);
	const rescueUsers = (requests[5]?.messages as Array<{ role?: string; content?: unknown }> | undefined)?.filter(({ role }) => role === "user") ?? [];
	assert.ok(rescueUsers.some(({ content }) => JSON.stringify(content).includes("write, edit, or command tool")));
	assert.equal(requests[5]?.tool_choice, "required");
	assert.equal(requests.length, 7);
	assert.ok(requests.every(request => Number(request.max_tokens ?? request.max_completion_tokens) > 12_000 && Number(request.max_tokens ?? request.max_completion_tokens) <= 128_000));
});

test("a truncated mutation gets exactly one executor action nudge and can complete", async () => {
	const root = await temporaryDirectory("codetonomy-action-nudge-success-");
	await writeFile(join(root, "README.md"), "# Mutation fixture\n", "utf8");
	let requestCount = 0;
	const providerFetch: typeof fetch = async () => {
		requestCount++;
		const base = { id: `action-nudge-success-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "action-model" };
		const events = requestCount === 1
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "inspect-before-write", type: "function", function: { name: "list_workspace", arguments: '{"path":".","depth":1}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: requestCount === 2
				? [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "I will plan the implementation first." }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
				]
				: requestCount === 3
					? [
						{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "write-after-nudge", type: "function", function: { name: "write_workspace", arguments: '{"path":"status.txt","content":"done\\n"}' } }] }, finish_reason: null }] },
						{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
					]
					: [
						{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Implemented status.txt." }, finish_reason: null }] },
						{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
					];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await createHarness().run({
		objective: "Implement a status file in this project",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "action-provider",
		modelId: "action-model",
		permissionMode: "auto",
		providerConfiguration: { id: "action-provider", name: "Action Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
	});
	assert.equal(requestCount, 4);
	assert.equal(result.verification.passed, true);
	assert.equal(await readFile(join(root, "status.txt"), "utf8"), "done\n");
	const trace = await readFile(result.tracePath, "utf8");
	assert.match(trace, /"promptKind":"action-nudge"/);
	assert.match(trace, /"actionNudgeIssued":true/);
	assert.match(trace, /"actionNudgeAttempts":1/);
	assert.match(trace, /"actionNudgeTrigger":"truncation"/);
	assert.match(trace, /"proactiveActionNudgeIssued":false/);
	assert.match(trace, /"truncationActionNudgeIssued":true/);
	assert.match(trace, /"modelOutputTruncations":1/);
});

test("a second truncation after the action nudge fails without generic repair", async () => {
	const root = await temporaryDirectory("codetonomy-action-nudge-repeat-");
	await writeFile(join(root, "README.md"), "# Repeat fixture\n", "utf8");
	let requestCount = 0;
	const providerFetch: typeof fetch = async () => {
		requestCount++;
		const base = { id: `action-nudge-repeat-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "repeat-model" };
		const events = requestCount === 1
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "inspect-before-repeat", type: "function", function: { name: "list_workspace", arguments: '{"path":".","depth":1}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Still planning", tool_calls: [{ index: 0, id: `truncated-write-${requestCount}`, type: "function", function: { name: "write_workspace", arguments: '{"path":"status.txt","content":"unsafe\\n"}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
			];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await createHarness().run({
		objective: "Implement a status file in this project",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "repeat-provider",
		modelId: "repeat-model",
		permissionMode: "auto",
		providerConfiguration: { id: "repeat-provider", name: "Repeat Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
	});
	assert.equal(requestCount, 3);
	assert.equal(result.verification.passed, false);
	assert.match(result.verification.checks.find(({ id }) => id === "runtime-complete")?.message ?? "", /^Model output limit reached \(\d+ tokens\)$/);
	const trace = await readFile(result.tracePath, "utf8");
	assert.equal((trace.match(/"outcome":"max-output"/g) ?? []).length, 2);
	assert.match(trace, /"actionNudgeAttempts":1/);
	assert.match(trace, /"truncationActionNudgeIssued":true/);
	assert.doesNotMatch(trace, /"attempt":1/);
});

test("verified work at the model turn boundary succeeds and records prompt growth", async () => {
	const root = await temporaryDirectory("codetonomy-turn-budget-success-");
	await writeFile(join(root, "README.md"), "# Boundary fixture\n", "utf8");
	let requestCount = 0;
	const providerFetch: typeof fetch = async () => {
		requestCount++;
		const base = { id: `budget-success-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "budget-model" };
		const toolCall = { index: 0, id: `budget-call-${requestCount}`, type: "function", function: { name: "list_workspace", arguments: '{"path":".","depth":1}' } };
		const events = [
			{ ...base, choices: [{ index: 0, delta: { role: "assistant", ...(requestCount === 12 ? { content: "The workspace contains README.md." } : {}), tool_calls: [toolCall] }, finish_reason: null }] },
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
		];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const events: Array<{ type: string; data: Record<string, unknown> }> = [];
	const result = await createHarness().run({
		objective: "Scan the codebase",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "budget-provider",
		modelId: "budget-model",
		maxModelTurns: 12,
		providerConfiguration: { id: "budget-provider", name: "Budget Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
		observers: [(event) => { events.push({ type: event.type, data: event.data }); }],
	});
	assert.equal(requestCount, 12);
	assert.equal(result.verification.passed, true);
	assert.equal(events.filter(({ type }) => type === "model.request.started").length, 12);
	const completed = events.filter(({ type }) => type === "model.request.completed");
	assert.equal(completed.at(-1)?.data.turnBudgetExhausted, true);
	assert.ok(Number(completed.at(-1)?.data.maxOutputTokens) > 8_000 && Number(completed.at(-1)?.data.maxOutputTokens) <= 128_000);
	assert.equal(typeof completed.at(-1)?.data.promptGrowthTokens, "number");
	assert.equal(events.find(({ type }) => type === "run.completed")?.data.turnBudgetExhausted, true);
});

test("verified action at the model turn boundary gets a neutral limit notice", async () => {
	const root = await temporaryDirectory("codetonomy-turn-budget-action-");
	let requestCount = 0;
	const providerFetch: typeof fetch = async () => {
		requestCount++;
		const base = { id: `budget-action-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "budget-model" };
		const toolCall = requestCount === 12
			? { index: 0, id: "budget-action-write", type: "function", function: { name: "write_workspace", arguments: '{"path":"status.txt","content":"done\\n"}' } }
			: { index: 0, id: `budget-action-list-${requestCount}`, type: "function", function: { name: "list_workspace", arguments: '{"path":".","depth":1}' } };
		const events = [
			{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [toolCall] }, finish_reason: null }] },
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
		];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await createHarness().run({
		objective: "Implement a status file in this project",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "budget-provider",
		modelId: "budget-model",
		maxModelTurns: 12,
		permissionMode: "auto",
		providerConfiguration: { id: "budget-provider", name: "Budget Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
	});
	assert.equal(requestCount, 12);
	assert.equal(result.verification.passed, true);
	assert.equal(result.output, "Model turn limit reached before a final answer. See verification checks for task status.");
	assert.equal(await readFile(join(root, "status.txt"), "utf8"), "done\n");
});

test("incomplete work at the model turn boundary fails without a repair turn", async () => {
	const root = await temporaryDirectory("codetonomy-turn-budget-failure-");
	let requestCount = 0;
	const providerFetch: typeof fetch = async () => {
		requestCount++;
		const base = { id: `budget-failure-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "budget-model" };
		const toolCall = { index: 0, id: `budget-failure-call-${requestCount}`, type: "function", function: { name: requestCount === 12 ? "inspect_workspace" : "list_workspace", arguments: requestCount === 12 ? '{"path":"missing.txt"}' : '{"path":".","depth":1}' } };
		const events = [
			{ ...base, choices: [{ index: 0, delta: { role: "assistant", ...(requestCount === 12 ? { content: "I could not finish the inspection." } : {}), tool_calls: [toolCall] }, finish_reason: null }] },
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
		];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await createHarness().run({
		objective: "Scan the codebase",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "budget-provider",
		modelId: "budget-model",
		maxModelTurns: 12,
		providerConfiguration: { id: "budget-provider", name: "Budget Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
	});
	assert.equal(requestCount, 12);
	assert.equal(result.verification.passed, false);
	assert.equal(result.verification.checks.find(({ id }) => id === "runtime-complete")?.message, "Model turn budget exhausted (12)");
});

test("automatic runs can finish beyond evaluation turn and tool-call budgets", async () => {
	const root = await temporaryDirectory("codetonomy-automatic-stopping-");
	await writeFile(join(root, "README.md"), "# Automatic stopping fixture\n", "utf8");
	let requestCount = 0;
	const providerFetch: typeof fetch = async () => {
		requestCount++;
		const base = { id: `automatic-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "automatic-model" };
		const events = requestCount <= 16
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [0, 1].map((index) => ({ index, id: `automatic-list-${requestCount}-${index}`, type: "function", function: { name: "list_workspace", arguments: '{"path":".","depth":1}' } })) }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "The workspace contains README.md." }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const observed: Array<{ type: string; data: Record<string, unknown> }> = [];
	const result = await createHarness().run({
		objective: "Inspect and summarize this workspace",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "automatic-provider",
		modelId: "automatic-model",
		providerConfiguration: { id: "automatic-provider", name: "Automatic Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
		observers: [(event) => { observed.push({ type: event.type, data: event.data }); }],
	});
	assert.equal(requestCount, 17);
	assert.equal(result.verification.passed, true);
	assert.equal(observed.filter(({ type }) => type === "tool.completed").length, 32);
	const completed = observed.find(({ type }) => type === "run.completed")?.data;
	assert.equal(completed?.modelTurns, 17);
	assert.equal(completed?.maxModelTurns, 100);
	assert.equal(completed?.maxToolCalls, 500);
});

test("read-only discovery gets a finalization reminder before the last turn", async () => {
	const root = await temporaryDirectory("codetonomy-finalization-nudge-");
	await writeFile(join(root, "README.md"), "# Finalization fixture\n", "utf8");
	const requests: Array<Record<string, unknown>> = [];
	const providerFetch: typeof fetch = async (_input, init) => {
		requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		const base = { id: `finalization-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "finalization-model" };
		const events = requests.length < 12
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `list-${requests.length}`, type: "function", function: { name: "list_workspace", arguments: '{"path":".","depth":1}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "The workspace contains README.md." }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await createHarness().run({
		objective: "Inspect and summarize this workspace",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "finalization-provider",
		modelId: "finalization-model",
		maxModelTurns: 12,
		providerConfiguration: { id: "finalization-provider", name: "Finalization Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
	});
	assert.equal(requests.length, 12);
	assert.equal(result.verification.passed, true);
	assert.match(JSON.stringify(requests[11]?.messages), /One model turn remains/);
	assert.match(await readFile(result.tracePath, "utf8"), /"promptKind":"finalization-nudge"/);
});

test("a turn-12 length stop does not schedule a truncation rescue", async () => {
	const root = await temporaryDirectory("codetonomy-turn-12-rescue-");
	await writeFile(join(root, "README.md"), "# Turn boundary fixture\n", "utf8");
	let requestCount = 0;
	const providerFetch: typeof fetch = async () => {
		requestCount++;
		const base = { id: `turn-12-rescue-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "budget-model" };
		const events = requestCount < 12
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `inspect-${requestCount}`, type: "function", function: { name: "list_workspace", arguments: '{"path":".","depth":1}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "I could not finish the implementation." }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
			];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const events: Array<{ type: string; data: Record<string, unknown> }> = [];
	const result = await createHarness().run({
		objective: "Implement a status file in this project",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "turn-12-rescue-provider",
		modelId: "budget-model",
		maxModelTurns: 12,
		permissionMode: "auto",
		providerConfiguration: { id: "turn-12-rescue-provider", name: "Turn 12 Rescue Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
		observers: [(event) => { events.push({ type: event.type, data: event.data }); }],
	});
	assert.equal(requestCount, 12);
	assert.equal(result.verification.passed, false);
	assert.match(result.verification.checks.find(({ id }) => id === "runtime-complete")?.message ?? "", /^Model output limit reached \(\d+ tokens\)$/);
	const run = events.find(({ type }) => type === "run.failed")?.data;
	assert.equal(run?.modelTurns, 12);
	assert.equal(run?.actionNudgeAttempts, 1);
	assert.equal(run?.proactiveActionNudgeIssued, true);
	assert.equal(run?.truncationActionNudgeIssued, false);
});

test("deterministic verification feedback repairs a real provider run within budget", async () => {
	const root = await temporaryDirectory("codetonomy-provider-repair-");
	await writeFile(join(root, "README.md"), "# Repair fixture\n", "utf8");
	let requestCount = 0;
	const providerFetch: typeof fetch = async () => {
		requestCount++;
		const base = { id: `repair-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "repair-model" };
		const choices = requestCount === 1
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "The project looks fine." }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			]
			: requestCount === 2
				? [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "repair-call", type: "function", function: { name: "list_workspace", arguments: '{"path":"."}' } }] }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
				]
				: [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "The workspace contains README.md." }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
				];
		return new Response(`${choices.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await createHarness().run({
		objective: "Scan the codebase",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "repair-provider",
		modelId: "repair-model",
		providerConfiguration: {
			id: "repair-provider",
			name: "Repair Provider",
			kind: "openai-compatible",
			baseUrl: "https://provider.test/v1",
			apiKey: "test-key",
		},
		providerFetch,
	});
	assert.equal(result.verification.passed, true);
	assert.equal(requestCount, 3);
	const trace = await readFile(result.tracePath, "utf8");
	assert.match(trace, /"type":"verification.failed"/);
	assert.match(trace, /"type":"verification.completed"/);
});

const finalizationProvider = (onRequest: (count: number) => void) => {
	const requests: Array<Record<string, unknown>> = [];
	const providerFetch: typeof fetch = async (_input, init) => {
		requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		onRequest(requests.length);
		const base = { id: `budget-finalization-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "budget-model" };
		const events = requests.length === 1
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "list-1", type: "function", function: { name: "list_workspace", arguments: '{"path":".","depth":1}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "The workspace contains README.md." }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	return { requests, providerFetch };
};

const runBudgetFinalization = async (name: string, onRequest: (count: number) => void, limits: { maxDurationMs?: number; maxToolCalls?: number }) => {
	const root = await temporaryDirectory(`codetonomy-${name}-finalization-`);
	await writeFile(join(root, "README.md"), "# Finalization fixture\n", "utf8");
	const { requests, providerFetch } = finalizationProvider(onRequest);
	const result = await createHarness().run({
		objective: "Inspect and summarize this workspace",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "budget-provider",
		modelId: "budget-model",
		...limits,
		providerConfiguration: { id: "budget-provider", name: "Budget Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
	});
	return { requests, result, trace: await readFile(result.tracePath, "utf8") };
};

test("a nearly spent run deadline asks for the final answer instead of aborting", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
	// 10s run keeps a 2.5s reserve; the first turn leaves 2s.
	const { requests, result, trace } = await runBudgetFinalization("deadline", (count) => { if (count === 1) t.mock.timers.tick(8_000); }, { maxDurationMs: 10_000 });
	assert.equal(requests.length, 2);
	assert.match(JSON.stringify(requests[1]?.messages), /time limit is nearly reached/);
	assert.equal(result.verification.passed, true);
	assert.match(trace, /"promptKind":"finalization-nudge"/);
	assert.match(trace, /"budgetFinalizationNudge":"deadline"/);
});

test("a spent tool-call budget asks for the final answer instead of blocking the next call", async () => {
	const { requests, result, trace } = await runBudgetFinalization("tool-budget", () => {}, { maxToolCalls: 1 });
	assert.equal(requests.length, 2);
	assert.match(JSON.stringify(requests[1]?.messages), /tool-call budget is spent/);
	assert.equal(result.verification.passed, true);
	assert.match(trace, /"budgetFinalizationNudge":"tool-calls"/);
});

test("a run with time and tools to spare gets no budget finalization nudge", async () => {
	const { requests, trace } = await runBudgetFinalization("spare", () => {}, {});
	assert.doesNotMatch(JSON.stringify(requests[1]?.messages), /time limit is nearly reached|tool-call budget is spent/);
	assert.doesNotMatch(trace, /budgetFinalizationNudge/);
});
