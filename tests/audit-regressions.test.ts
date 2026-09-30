import assert from "node:assert/strict";
import { mkdir, readFile, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createHarness } from "../packages/runtime/src/index.ts";
import { RunCheckpoint, rewindCheckpoint } from "../packages/runtime/src/checkpoint.ts";
import { compileTask } from "../packages/task-compiler/src/index.ts";
import { bashTool, CommandOutputStore, resolveCodexBinary, runWorkspaceCommandTool, writeWorkspaceTool } from "../packages/tools/src/index.ts";
import { verifyOutput } from "../packages/verifiers/src/index.ts";
import { tempDirs } from "./support/temp.ts";

const temporaryDirectory = tempDirs();

const commandOutputStore = (workspaceRoot: string) => new CommandOutputStore({
	workspaceRoot,
	outputDirectory: join(workspaceRoot, `.command-output-${randomUUID()}`),
});

test("sensitive command preflight checks ignored directories and linked directories", async (t) => {
	const root = await temporaryDirectory("codetonomy-sensitive-regression-");
	for (const directory of ["node_modules", ".git", ".codetonomy", "dist", ".reference-repos"]) {
		const workspace = join(root, directory.slice(1) || "workspace");
		await mkdir(join(workspace, directory), { recursive: true });
		await writeFile(join(workspace, directory, ".env"), "DUMMY=fixture");
		for (const commandSandboxMode of ["workspace", "read-only"] as const) {
			await assert.rejects(() => runWorkspaceCommandTool(workspace, {
				codexBinary: process.execPath, commandSandboxMode, outputStore: commandOutputStore(workspace),
			}).execute("blocked", { argv: ["ignored"] }), /commands are blocked.*sensitive path/);
		}
	}
	const workspace = join(root, "linked-workspace");
	const target = join(root, "linked-target");
	await mkdir(workspace); await mkdir(target);
	await writeFile(join(target, ".env"), "DUMMY=fixture");
	await symlink(target, join(workspace, "dependency"), process.platform === "win32" ? "junction" : "dir");
	await assert.rejects(() => runWorkspaceCommandTool(workspace, { codexBinary: process.execPath, outputStore: commandOutputStore(workspace) })
		.execute("linked", { argv: ["ignored"] }), /commands are blocked.*sensitive path/);
	await unlink(join(target, ".env"));
	await symlink(workspace, join(target, "cycle"), process.platform === "win32" ? "junction" : "dir");
	await writeFile(join(workspace, "sandbox"), "process.exit(0);");
	assert.equal((await runWorkspaceCommandTool(workspace, { codexBinary: process.execPath, outputStore: commandOutputStore(workspace) })
		.execute("cycle", { argv: ["ignored"] })).details.exitCode, 0);
});

test("sandbox mount placeholders for protected names are not workspace changes", async (t) => {
	const root = await temporaryDirectory("codetonomy-placeholder-regression-");
	const state = await temporaryDirectory("codetonomy-placeholder-state-");
	const checkpoint = new RunCheckpoint(root, "regression", join(state, "checkpoint.json"));
	await checkpoint.beforeWorkspace();
	// A killed Linux sandbox can leave the empty mount targets it created for protected paths.
	for (const name of [".git", ".agents", ".codex", ".codetonomy", ".harness", ".pnpm-store", "node_modules"]) await writeFile(join(root, name), "");
	await mkdir(join(root, "pkg"));
	await writeFile(join(root, "pkg", "node_modules"), "");
	await writeFile(join(root, "changed.txt"), "real change");
	assert.deepEqual(await checkpoint.afterWorkspace(), ["changed.txt"]);
	assert.equal(checkpoint.workspaceCaptureComplete(), true);
});

test("rewind retains the original preimage after deletion and recreation across commands", async (t) => {
	const root = await temporaryDirectory("codetonomy-rewind-regression-");
	const file = join(root, "existing.txt");
	await writeFile(file, "original");
	const checkpointPath = join(root, ".harness", "checkpoint.json");
	const checkpoint = new RunCheckpoint(root, "regression", checkpointPath);
	await checkpoint.beforeWorkspace(); await unlink(file); await checkpoint.afterWorkspace();
	await checkpoint.beforeWorkspace(); await writeFile(file, "replacement"); await checkpoint.afterWorkspace();
	assert.equal(JSON.parse(await readFile(checkpointPath, "utf8")).files.filter((entry: { path: string }) => entry.path === "existing.txt").length, 1);
	await rewindCheckpoint(checkpointPath, root);
	assert.equal(await readFile(file, "utf8"), "original");
});

test("native Bash provides exact evidence only for a parsed single command", async (t) => {
	const root = await temporaryDirectory("codetonomy-bash-evidence-");
	await writeFile(join(root, "sandbox"), "process.exit(0);");
	const tool = bashTool(root, { codexBinary: process.execPath, outputStore: commandOutputStore(root) });
	for (const command of ["npm test", "npm run test", "npm test || true", "echo npm test"]) {
		const result = await tool.execute(command, { command });
		const details = result.details as { argv: string[]; semanticArgv?: string[]; exitCode: number };
		assert.ok(details.argv.includes("-c"));
		const checked = verifyOutput("Tests completed", undefined, {
			task: compileTask({ objective: "Run npm test" }), completedToolIds: ["inspect_workspace", "run_workspace_command"],
			commandRuns: [{ argv: details.semanticArgv ?? details.argv, exitCode: details.exitCode }],
		});
		assert.equal(checked.passed, command === "npm test" || command === "npm run test", command);
	}
	await writeFile(join(root, "sandbox"), "process.exit(1);");
	const failed = await tool.execute("failure", { command: "npm test" });
	const details = failed.details as { semanticArgv: string[]; exitCode: number };
	assert.equal(verifyOutput("Tests completed", undefined, {
		task: compileTask({ objective: "Run npm test" }), completedToolIds: ["inspect_workspace", "run_workspace_command"],
		commandRuns: [{ argv: details.semanticArgv, exitCode: details.exitCode }],
	}).passed, false);
});

test("runtime accepts successful native Bash command evidence without repair", async (t) => {
	const root = await temporaryDirectory("codetonomy-bash-runtime-");
	const previousCodex = process.env.CODETONOMY_CODEX_BIN;
	process.env.CODETONOMY_CODEX_BIN = process.execPath;
	t.after(() => {
		if (previousCodex === undefined) delete process.env.CODETONOMY_CODEX_BIN;
		else process.env.CODETONOMY_CODEX_BIN = previousCodex;
	});
	await writeFile(join(root, "sandbox"), "process.exit(0);");
	let requests = 0;
	const providerFetch: typeof fetch = async () => {
		const request = ++requests;
		const command = request === 1 ? "ls" : "npm test";
		const delta = request <= 2
			? { role: "assistant", tool_calls: [{ index: 0, id: `call-${request}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] }
			: { role: "assistant", content: "Tests passed." };
		const base = { id: `response-${request}`, object: "chat.completion.chunk", created: 1, model: "test-model" };
		const events = [
			{ ...base, choices: [{ index: 0, delta, finish_reason: null }] },
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: request <= 2 ? "tool_calls" : "stop" }] },
		];
		return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
	};
	const result = await createHarness().run({
		objective: "Run npm test", workspaceRoot: root, traceDirectory: join(root, ".harness", "runs"),
		provider: "test-provider", modelId: "test-model", toolInterface: "bash", permissionMode: "auto",
		providerConfiguration: { id: "test-provider", name: "Test", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
	});
	assert.equal(result.verification.passed, true, JSON.stringify(result.verification.checks));
	assert.equal(requests, 3);
});

test("structured writes protect runtime directories before creating parents, including aliases", async (t) => {
	const root = await temporaryDirectory("codetonomy-protected-writes-");
	let captures = 0;
	const tool = writeWorkspaceTool(root, { before: async () => { captures++; }, after: async () => {} });
	for (const path of [".git/config", ".codex/hooks/run.sh", ".agents/skills/run.md", ".codetonomy/workers/run", "nested/.git/config"]) {
		await assert.rejects(() => tool.execute("write", { path, content: "DUMMY" }), /protected/);
		await assert.rejects(() => stat(dirname(join(root, path))), /ENOENT/);
	}
	await mkdir(join(root, ".git"));
	await writeFile(join(root, ".git/config"), "original");
	await symlink(join(root, ".git"), join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
	await assert.rejects(() => tool.execute("alias", { path: "alias/config", content: "replacement" }), /protected/);
	assert.equal(await readFile(join(root, ".git/config"), "utf8"), "original");
	assert.equal(captures, 0);
	await mkdir(join(root, "blocked-parent"));
	let settlements = 0;
	await assert.rejects(() => writeWorkspaceTool(root, {
		before: async () => {
			await rm(join(root, "blocked-parent"), { recursive: true });
			await writeFile(join(root, "blocked-parent"), "file");
		},
		after: async () => { settlements++; },
	})
		.execute("blocked-parent", { path: "blocked-parent/child.txt", content: "DUMMY" }));
	assert.equal(settlements, 1);
	await mkdir(join(root, "runtime-private"));
	const outputStore = new CommandOutputStore({ workspaceRoot: root });
	await assert.rejects(() => runWorkspaceCommandTool(root, { codexBinary: process.execPath, outputStore, privatePaths: [join(root, "runtime-private")] })
		.execute("private-cwd", { argv: ["ignored"], cwd: "runtime-private" }), /private runtime state/);
});

test("worker discovery ignores project-local executables unless explicitly configured", async (t) => {
	const root = await temporaryDirectory("codetonomy-runtime-discovery-");
	// Windows taskkill can briefly retain the worker's inherited working directory.
	const oldCwd = process.cwd();
	const keys = ["CODETONOMY_CODEX_BIN", "CODETONOMY_HOME", "CODETONOMY_WORKER_ROOT"];
	const oldEnvironment = keys.map((key) => process.env[key]);
	const fakeCodex = join(root, ".codetonomy/workers/codex/node_modules/.bin/codex");
	await mkdir(dirname(fakeCodex), { recursive: true });
	await writeFile(fakeCodex, "inert test candidate");
	try {
		for (const key of keys) delete process.env[key];
		process.chdir(root);
		assert.notEqual(resolveCodexBinary(), fakeCodex);
		await mkdir(join(root, "nested"));
		process.chdir(join(root, "nested"));
		assert.notEqual(resolveCodexBinary(), fakeCodex);
		assert.equal(resolveCodexBinary(fakeCodex), fakeCodex);
	} finally {
		process.chdir(oldCwd);
		keys.forEach((key, index) => oldEnvironment[index] === undefined ? delete process.env[key] : process.env[key] = oldEnvironment[index]);
	}
});

test("read-only commands skip mutation capture; writable checkpoints track actual changes", async (t) => {
	const root = await temporaryDirectory("codetonomy-checkpoint-evidence-");
	await writeFile(join(root, "sandbox"), "process.exit(0);");
	let captures = 0;
	const readOnly = await runWorkspaceCommandTool(root, { codexBinary: process.execPath, commandSandboxMode: "read-only", outputStore: commandOutputStore(root), observer: { before: async () => {}, after: async () => {}, beforeWorkspace: async () => { captures++; }, afterWorkspace: async () => { captures++; } } }).execute("read-only", { argv: ["ignored"] });
	assert.equal(captures, 0);
	assert.equal((readOnly.details as Record<string, unknown>).checkpointCount, 0);
	assert.equal((readOnly.details as Record<string, unknown>).mutationRisk, "none");
	await writeFile(join(root, "existing.txt"), "original");
	const checkpoint = new RunCheckpoint(root, "audit", join(root, ".harness/checkpoint.json"));
	await checkpoint.beforeWorkspace();
	assert.deepEqual(await checkpoint.afterWorkspace(), []);
	await checkpoint.beforeWorkspace();
	await writeFile(join(root, "existing.txt"), "changed");
	await writeFile(join(root, "new.txt"), "created");
	assert.deepEqual((await checkpoint.afterWorkspace()).sort(), ["existing.txt", "new.txt"]);
	await checkpoint.beforeWorkspace();
	await unlink(join(root, "new.txt"));
	assert.deepEqual(await checkpoint.afterWorkspace(), ["new.txt"]);
	await rewindCheckpoint(checkpoint.path!, root);
	assert.equal(await readFile(join(root, "existing.txt"), "utf8"), "original");
});

test("npm Codex launchers resolve to the native worker before PATH restriction", async (t) => {
	const root = await temporaryDirectory("codetonomy-npm-worker-");
	const launcher = join(root, "node_modules/@openai/codex/bin/codex.js");
	const platformPackage = join(root, "node_modules/@openai", `codex-${process.platform}-${process.arch}`);
	const binary = join(platformPackage, "vendor/test-target/bin", process.platform === "win32" ? "codex.exe" : "codex");
	await mkdir(dirname(launcher), { recursive: true });
	await mkdir(dirname(binary), { recursive: true });
	await writeFile(launcher, "#!/usr/bin/env node\n");
	await writeFile(join(platformPackage, "package.json"), "{}");
	await writeFile(binary, "native test candidate");
	assert.equal(resolveCodexBinary(launcher), await realpath(binary));
});
