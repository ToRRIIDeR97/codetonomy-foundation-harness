import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { skipUnless } from "./support/environment.ts";
import { bashTool, CommandOutputStore, createNativeBashArgv, createCodexSandboxInvocation, normalizeWorkspaceCommandArgv, planBashCommand, resolveCodexBinary, runWorkspaceCommandTool } from "../packages/tools/src/index.ts";

const codex = resolveCodexBinary();
const available = spawnSync(codex, ["--version"], { stdio: "ignore" }).status === 0;
const sandboxRequired = process.env.CI === "true" || process.env.CODETONOMY_REQUIRE_SANDBOX === "1";
test("native Codex sandbox permits workspace writes and blocks escape and network", { skip: !available && !sandboxRequired }, async (t) => {
	assert.equal(available, true, `Codex sandbox binary is unavailable: ${codex}`);
	const parent = await mkdtemp(join(process.cwd(), ".codetonomy-sandbox-"));
	const workspace = join(parent, "workspace");
	const configurationDirectory = join(homedir(), `.codetonomy-sandbox-config-${randomUUID()}`);
	const credentials = join(configurationDirectory, "credentials.env");
	const outside = join(homedir(), `.codetonomy-sandbox-escape-${randomUUID()}`);
	t.after(async () => {
		await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		await rm(configurationDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		await rm(outside, { force: true });
	});
	await mkdir(workspace);
	await mkdir(configurationDirectory);
	await writeFile(credentials, "SECRET=not-readable\n", { mode: 0o600 });
	await writeFile(join(workspace, "sandbox-runtime.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; test('runtime', () => assert.equal(2 + 2, 4));\n");
	const invocation = (argv: string[]) => {
		const previous = process.env.CODETONOMY_HOME;
		process.env.CODETONOMY_HOME = configurationDirectory;
		try { return createCodexSandboxInvocation(workspace, argv); }
		finally {
			if (previous === undefined) delete process.env.CODETONOMY_HOME;
			else process.env.CODETONOMY_HOME = previous;
		}
	};
	const run = (argv: string[]) => spawnSync(codex, invocation(argv), {
		cwd: workspace,
		encoding: "utf8",
		timeout: 10_000,
	});

	const state = JSON.parse(invocation([process.execPath])[2]!) as {
		permissionProfile: { network: string; file_system: { entries: Array<{ access: string; path: { type: string; path?: string; value?: { kind?: string } } }> } };
	};
	assert.equal(state.permissionProfile.network, "restricted");
	assert.ok(state.permissionProfile.file_system.entries.some(({ access, path }) => access === "read" && path.value?.kind === "minimal"));
	assert.equal(state.permissionProfile.file_system.entries.some(({ access, path }) => access !== "deny" && path.path === credentials), false);
	assert.ok(state.permissionProfile.file_system.entries.some(({ access, path }) => access === "deny" && path.path === configurationDirectory));

	const inside = run([process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'ok')", "inside.txt"]);
	assert.equal(inside.status, 0, inside.stderr || inside.stdout);
	assert.equal(await readFile(join(workspace, "inside.txt"), "utf8"), "ok");

	const escaped = run([process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'no')", outside]);
	assert.notEqual(escaped.status, 0);
	assert.equal(existsSync(outside), false);

	const network = run([process.execPath, "-e", "const s=require('node:net').connect(80,'1.1.1.1');s.setTimeout(2000);s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1));s.on('timeout',()=>process.exit(1))"]);
	assert.notEqual(network.status, 0);

	const sensitiveRead = run([process.execPath, "-e", "try{process.exit(require('node:fs').readFileSync(process.argv[1],'utf8').includes('SECRET=not-readable')?1:0)}catch{process.exit(0)}", credentials]);
	assert.equal(sensitiveRead.status, 0, sensitiveRead.stderr || sensitiveRead.stdout);

	const toolchain = run([process.execPath, "-e", "import('./sandbox-runtime.test.mjs')"]);
	assert.equal(toolchain.status, 0, toolchain.stderr || toolchain.stdout);
	if (process.platform === "win32") {
		const npm = run(normalizeWorkspaceCommandArgv(["npm", "--version"]));
		assert.equal(npm.status, 0, npm.stderr || npm.stdout);
		assert.match(npm.stdout, /^\d+\.\d+\.\d+/);
	}
});

test("native Codex full-access invocation serializes the unrestricted profile", { skip: !available && !sandboxRequired }, () => {
	assert.equal(available, true, `Codex sandbox binary is unavailable: ${codex}`);
	const root = tmpdir();
	const command = [process.execPath, "-e", "console.log('ok')"];
	const invocation = createCodexSandboxInvocation(root, command, { commandSandboxMode: "full-access" });
	const state = JSON.parse(invocation[2]!) as { permissionProfile: { type: string } };
	assert.equal(state.permissionProfile.type, "disabled");
	assert.equal(invocation.includes("--sandbox-state-disable-network"), false);
	assert.deepEqual(invocation.slice(-4), ["--", ...command]);
	const executed = spawnSync(codex, invocation, { cwd: root, encoding: "utf8", timeout: 10_000 });
	assert.equal(executed.status, 0, executed.stderr || executed.stdout);
	assert.match(executed.stdout, /ok/);
});

test("native Codex read-only sandbox permits inspection and blocks workspace writes", { skip: !available && !sandboxRequired }, async (t) => {
	assert.equal(available, true, `Codex sandbox binary is unavailable: ${codex}`);
	const parent = await mkdtemp(join(process.platform === "darwin" ? homedir() : process.cwd(), ".codetonomy-read-only-sandbox-"));
	const workspace = join(parent, "workspace");
	await mkdir(workspace);
	await writeFile(join(workspace, "evidence.txt"), "readable\n");
	t.after(() => rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
	const invocation = (argv: string[]) => createCodexSandboxInvocation(workspace, argv, { commandSandboxMode: "read-only" });
	const state = JSON.parse(invocation([process.execPath])[2]!) as {
		permissionProfile: { file_system: { entries: Array<{ access: string; path: { value?: { kind?: string } } }> } };
	};
	assert.ok(state.permissionProfile.file_system.entries.some(({ access, path }) => access === "read" && path.value?.kind === "project_roots"));

	const inspected = spawnSync(codex, invocation([process.execPath, "-e", "process.exit(require('node:fs').readFileSync('evidence.txt','utf8') === 'readable\\n' ? 0 : 2)"]), {
		cwd: workspace,
		encoding: "utf8",
		timeout: 10_000,
	});
	assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout);

	const write = spawnSync(codex, invocation([process.execPath, "-e", "require('node:fs').writeFileSync('forbidden.txt','no')"]), {
		cwd: workspace,
		encoding: "utf8",
		timeout: 10_000,
	});
	assert.notEqual(write.status, 0);
	assert.equal(existsSync(join(workspace, "forbidden.txt")), false);
});

test("macOS platform-default scratch access cannot masquerade as workspace isolation", { skip: process.platform !== "darwin" }, async (t) => {
	const root = await mkdtemp("/private/tmp/codetonomy-platform-default-");
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "a.txt"), "evidence");
	assert.equal(planBashCommand({ command: "cat a.txt" }, root).readOnly, false);
	for (const workspace of [root, root.replace("/private/tmp/", "/tmp/")]) {
		assert.throws(() => createCodexSandboxInvocation(workspace, [process.execPath], { commandSandboxMode: "read-only" }), /cannot enforce a read-only workspace/);
	}
	assert.throws(() => createCodexSandboxInvocation(homedir(), [process.execPath], { privatePaths: [root] }), /overlap private state/);
});

test("Bash rg fallback preserves matches and read-only enforcement", { skip: !available && !sandboxRequired }, async t => {
 const argv = createNativeBashArgv("command -v rg");
 if (skipUnless(t, spawnSync(argv[0]!, argv.slice(1), { stdio: "ignore" }).status === 0, "Native Bash/rg unavailable")) return;
 const parent = await mkdtemp(join(tmpdir(), "codetonomy-bash-sandbox-"));
 const root = join(parent, "workspace");
 await mkdir(root);
 t.after(() => rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
 await writeFile(join(root, "evidence.txt"), "alpha\nbeta\n");
 const outputStore = new CommandOutputStore({ workspaceRoot: root, outputDirectory: join(root, "command-output") });
 const tool = bashTool(root, { commandSandboxMode: "read-only", codexBinary: codex, outputStore });
 const matched = await tool.execute("patterns", { command: "rg -F alpha evidence.txt" });
 assert.equal((matched.details as { exitCode: number }).exitCode, 0, JSON.stringify(matched));
 assert.equal(matched.content[0]?.type === "text" ? matched.content[0].text : "", "alpha\n");
 assert.equal((matched.details as Record<string, unknown>).mutationRisk, "none");
 assert.equal((matched.details as Record<string, unknown>).checkpointCount, 0);
 const noMatch = await tool.execute("no-match", { command: "rg -F absent evidence.txt" });
 assert.equal((noMatch.details as Record<string, unknown>).exitCode, 1);
 assert.equal((noMatch.details as Record<string, unknown>).resultKind, "no-matches");
 assert.equal((noMatch.details as Record<string, unknown>).mutationRisk, "none");
 const searchError = await tool.execute("search-error", { command: "rg --regexp '[' evidence.txt" });
 assert.equal((searchError.details as Record<string, unknown>).exitCode, 2);
 assert.equal((searchError.details as Record<string, unknown>).resultKind, "failure");
 assert.equal((searchError.details as Record<string, unknown>).mutationRisk, "none");
 const denied = await tool.execute("write", { command: "rg --files > forbidden.txt" });
 assert.notEqual((denied.details as { exitCode: number }).exitCode, 0);
 assert.equal(existsSync(join(root, "forbidden.txt")), false);
 await assert.rejects(tool.execute("escape", { command: "cat ../outside.txt" }), /escapes the workspace/);
});

test("workspace sandbox cannot modify the private command-output store", { skip: !available && !sandboxRequired }, async (t) => {
	assert.equal(available, true, `Codex sandbox binary is unavailable: ${codex}`);
	const workspace = await mkdtemp(join(tmpdir(), "codetonomy-output-deny-workspace-"));
	const outputRoot = await mkdtemp(join(tmpdir(), "codetonomy-output-deny-private-"));
	const outputStore = new CommandOutputStore({ workspaceRoot: workspace, outputDirectory: join(outputRoot, "capture") });
	const attackerPath = join(outputStore.outputDirectory, "attacker.txt");
	t.after(async () => {
		await rm(workspace, { recursive: true, force: true });
		await rm(outputRoot, { recursive: true, force: true });
	});
	const result = await runWorkspaceCommandTool(workspace, { codexBinary: codex, commandSandboxMode: "workspace", outputStore }).execute("deny-output", {
		argv: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(attackerPath)}, 'tampered')`],
	});
	assert.notEqual((result.details as Record<string, unknown>).exitCode, 0);
	assert.equal(existsSync(attackerPath), false);
	assert.equal(typeof (result.details as Record<string, unknown>).outputId, "string");

	const owner = new CommandOutputStore({ workspaceRoot: workspace });
	const capture = owner.createCapture("owner");
	await capture.append(Buffer.from("cross-run secret"));
	const receipt = await capture.finish(true);
	const sealedPath = join(owner.outputDirectory, `${receipt.outputId}.output`);
	const other = new CommandOutputStore({ workspaceRoot: workspace });
	t.after(async () => {
		await owner.discard().catch(() => undefined);
		await other.discard().catch(() => undefined);
	});
	const crossRun = await runWorkspaceCommandTool(workspace, { codexBinary: codex, commandSandboxMode: "workspace", outputStore: other }).execute("cross-run", {
		argv: [process.execPath, "-e", `process.exit(require('node:fs').readFileSync(${JSON.stringify(sealedPath)}, 'utf8') === 'cross-run secret' ? 0 : 2)`],
	});
	// On Windows this relies on the store's owner-only DACL rather than sandbox read denials (#19).
	assert.notEqual((crossRun.details as Record<string, unknown>).exitCode, 0);
});

test("sandbox policy keeps parent denials without redundant child mounts", () => {
	const workspace = homedir();
	const privateRoot = join(workspace, ".codetonomy-policy-fixture");
	const args = createCodexSandboxInvocation(workspace, [process.execPath], { privatePaths: [privateRoot, join(privateRoot, "capture"), join(privateRoot, "capture/manifest.json"), privateRoot] });
	const state = JSON.parse(args[args.indexOf("--sandbox-state-json") + 1]!);
	const denials = state.permissionProfile.file_system.entries.filter((entry: { access: string }) => entry.access === "deny").map((entry: { path: { path: string } }) => entry.path.path);
	if (process.platform === "win32") {
		assert.ok(!state.permissionProfile.file_system.entries.some((entry: { path: { value?: { kind?: string } } }) => entry.path.value?.kind === "tmpdir"));
	}
	assert.equal(denials.filter((path: string) => path === privateRoot).length, 1);
	assert.ok(!denials.includes(join(privateRoot, "capture")));
	assert.ok(!denials.includes(join(privateRoot, "capture/manifest.json")));
});

test("read-only harness Bash fallback permits pipelines without granting command capability", { skip: !available && !sandboxRequired }, async t => {
 const { createHarness } = await import("../packages/runtime/src/index.ts");
 const root = await mkdtemp(join(process.cwd(), ".live-read-regression-"));
 t.after(() => rm(root, { recursive: true, force: true }));
 await writeFile(join(root, "evidence.txt"), "alpha\nbeta\n");
 let requests = 0;
 const result = await createHarness().run({
  objective: "Inspect the workspace and report the first line of the evidence file. Do not modify files.", workspaceRoot: root,
  // Read-only tool profiles are explicit since 6490d9c; the default is the seven-tool coding bundle.
  traceDirectory: join(root, ".harness/runs"), permissionMode: "auto", toolInterface: "bash", presetId: "general-assistant",
  provider: "read-test", modelId: "test", maxModelTurns: 2, providerRetryLimit: 0,
  providerConfiguration: { id: "read-test", name: "Test", kind: "openai-compatible", baseUrl: "https://test.invalid/v1", apiKey: "test-key" },
  providerFetch: async () => {
   const delta = ++requests === 1 ? { role: "assistant", tool_calls: [{ index: 0, id: "read", type: "function", function: { name: "bash", arguments: JSON.stringify({command: "cat evidence.txt | head -1"}) } }] } : { role: "assistant", content: "alpha" };
   const chunk = (delta: unknown, finish_reason: string | null) => ({ id: "test", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta, finish_reason }] });
   return new Response(`data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, requests === 1 ? "tool_calls" : "stop"))}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  },
 });
 assert.equal(result.verification.passed, true, JSON.stringify(result.verification));
 assert.equal(result.capabilities.canonicalToolIds?.includes("run_workspace_command"), false);
 const store = new CommandOutputStore({workspaceRoot: root, outputDirectory: join(root, "private-output")});
 const tool = bashTool(root, {commandSandboxMode: "read-only", allowReadOnlyFallback: true, nativeOperationId: "inspect_workspace", allowedCanonicalToolIds: ["inspect_workspace"], outputStore: store});
 const listing = await tool.execute("list", {command: "ls -la | head -5"});
 assert.equal((listing.details as any).exitCode, 0);
 const denied = await tool.execute("write", {command: "printf changed > evidence.txt"});
 assert.notEqual((denied.details as any).exitCode, 0);
 assert.equal((denied.details as any).mutationRisk, "none");
 assert.equal(await readFile(join(root, "evidence.txt"), "utf8"), "alpha\nbeta\n");
 await assert.rejects(tool.execute("escape", {command: "cat ../outside.txt"}), /escapes/);
 await assert.rejects(bashTool(root, {commandSandboxMode: "read-only", allowedCanonicalToolIds: ["inspect_workspace"], outputStore: store}).execute("restricted", {command: "cat evidence.txt | head -1"}), /unavailable/);
});

test("native application recovery retains evidence and permits a corrected required test", { skip: !available && !sandboxRequired }, async t => {
 const { createHarness } = await import("../packages/runtime/src/index.ts");
 const root = await mkdtemp(join(process.cwd(), ".app-recovery-regression-"));
 t.after(() => rm(root, { recursive: true, force: true }));
 await writeFile(join(root, "BRIEF.md"), "Create a working app.");
 await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node app.mjs" } }));
 const calls = [
  ["bash", { command: "cat BRIEF.md" }],
  ["write_workspace", { path: "README.md", content: "Usage" }],
  ["write_workspace", { path: "README.md", content: "Usage" }],
  ["write_workspace", { path: "app.mjs", content: "process.exit(1);" }],
  ["bash", { command: "npm test" }],
  ["bash", { command: "cat app.mjs" }],
  ["edit_workspace", { path: "app.mjs", oldText: "process.exit(1);", newText: "process.exit(2);" }],
  ["edit_workspace", { path: "app.mjs", oldText: "process.exit(2);", newText: "process.exit(0);" }],
  ["bash", { command: "npm test" }],
 ] as const;
 let requests = 0;
 const result = await createHarness().run({
  objective: "Read BRIEF.md. Create app.mjs. Write README.md. Run npm test.", workspaceRoot: root,
  traceDirectory: join(root, ".harness/runs"), permissionMode: "auto", toolInterface: "bash", maxModelTurns: 12,
  provider: "app-test", modelId: "test", providerRetryLimit: 0,
  providerConfiguration: { id: "app-test", name: "Test", kind: "openai-compatible", baseUrl: "https://test.invalid/v1", apiKey: "test-key" },
  providerFetch: async () => {
   const call = calls[requests++];
   const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${requests}`, type: "function", function: { name: call[0], arguments: JSON.stringify(call[1]) } }] } : { role: "assistant", content: "App and tests completed." };
   const chunk = (delta: unknown, finish_reason: string | null) => ({ id: "test", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta, finish_reason }] });
   return new Response(`data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, call ? "tool_calls" : "stop"))}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  },
 });
 assert.equal(result.verification.passed, true, JSON.stringify(result.verification));
 assert.equal(requests, calls.length + 1, "No verification repair should be needed after the corrected test");
});

test("native optional demo failure permits inspected required validation without replay", { skip: !available && !sandboxRequired }, async t => {
 const { createHarness } = await import("../packages/runtime/src/index.ts");
 const root = await mkdtemp(join(process.cwd(), ".app-continuation-regression-"));
 t.after(() => rm(root, { recursive: true, force: true }));
 await writeFile(join(root, "BRIEF.md"), "Build the app.");
 await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }));
 const calls = [
  ["bash", { command: "cat BRIEF.md; ls -la" }],
  ["bash", { command: "node missing-demo.mjs" }],
  ["write_workspace", { path: "README.md", content: "Usage" }],
  ["bash", { command: "cat BRIEF.md" }],
  ["bash", { command: "npm test" }],
 ] as const;
 let requests = 0;
 const result = await createHarness().run({
  objective: "Read BRIEF.md. Write README.md. Run npm test.", workspaceRoot: root,
  traceDirectory: join(root, ".harness/runs"), permissionMode: "auto", toolInterface: "bash", maxModelTurns: 10,
  provider: "app-test", modelId: "test", providerRetryLimit: 0,
  providerConfiguration: { id: "app-test", name: "Test", kind: "openai-compatible", baseUrl: "https://test.invalid/v1", apiKey: "test-key" },
  providerFetch: async (_input, init) => {
   if (requests === 1) assert.match(String(init?.body), /standalone cat/);
   const call = calls[requests++];
   const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${requests}`, type: "function", function: { name: call[0], arguments: JSON.stringify(call[1]) } }] } : { role: "assistant", content: "App and tests completed." };
   const chunk = (delta: unknown, finish_reason: string | null) => ({ id: "test", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta, finish_reason }] });
   return new Response(`data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, call ? "tool_calls" : "stop"))}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  },
 });
 assert.equal(result.verification.passed, true, JSON.stringify(result.verification));
 assert.equal(requests, calls.length + 1);
});

test("sandboxed commands deny the default configuration directory when CODETONOMY_HOME is unset", () => {
	const previous = process.env.CODETONOMY_HOME;
	delete process.env.CODETONOMY_HOME;
	try {
		const args = createCodexSandboxInvocation(process.cwd(), [process.execPath]);
		const state = JSON.parse(args[args.indexOf("--sandbox-state-json") + 1]!);
		const denials = state.permissionProfile.file_system.entries.filter((entry: { access: string }) => entry.access === "deny").map((entry: { path: { path: string } }) => entry.path.path);
		assert.ok(denials.includes(join(homedir(), ".codetonomy")), JSON.stringify(denials));
	} finally {
		if (previous === undefined) delete process.env.CODETONOMY_HOME;
		else process.env.CODETONOMY_HOME = previous;
	}
});
