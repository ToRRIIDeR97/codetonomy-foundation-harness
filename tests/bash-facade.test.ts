import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import test from "node:test";
import { buildStableSystemPrompt, resolveCapabilities } from "../packages/capability-compiler/src/index.ts";
import type { ToolPermissionRequest } from "../packages/contracts/src/index.ts";
import { createHarness, resolveToolInterface } from "../packages/runtime/src/index.ts";
import { compileTask } from "../packages/task-compiler/src/index.ts";
import { skipWithoutRipgrep } from "./support/environment.ts";
import { BashCommandPlanner, bashPermissionTargets, bashPlanUsesReadOnlySandbox, bashTool, CommandOutputStore, createCodexSandboxInvocation, createNativeBashArgv, parseBashCommand, planBashCommand, searchWorkspaceTool } from "../packages/tools/src/index.ts";
import { tempDirs } from "./support/temp.ts";

const temporaryDirectory = tempDirs();

const testBashTool = (workspaceRoot: string, options: Omit<Parameters<typeof bashTool>[1], "outputStore"> = {}) => bashTool(workspaceRoot, {
	...options,
	outputStore: new CommandOutputStore({ workspaceRoot, outputDirectory: join(workspaceRoot, `.command-output-${randomUUID()}`) }),
});

test("bash accelerator parser recognizes its bounded semantics-preserving subset", () => {
	assert.deepEqual(parseBashCommand({ command: "rg -niF 'two words' src", cwd: "packages" }), {
		kind: "search",
		query: "two words",
		path: "packages/src",
		exact: true,
		ignoreCase: true,
	});
	assert.deepEqual(parseBashCommand({ command: "sed -n '20,35p' src/app.ts" }), {
		kind: "read",
		mode: "sed",
		path: "src/app.ts",
		offset: 20,
		limit: 16,
	});
	assert.deepEqual(parseBashCommand({ command: "ls -la src" }), { kind: "list", path: "src", long: true, all: true });
	assert.deepEqual(parseBashCommand({ command: "npm test -- --runInBand", timeoutSeconds: 30 }), {
		kind: "command",
		argv: ["npm", "test", "--", "--runInBand"],
		cwd: ".",
		timeoutSeconds: 30,
	});
	assert.deepEqual(parseBashCommand({ command: "cat /workspace/packages/tools/src/index.ts", cwd: "/workspace/packages" }), {
		kind: "read",
		mode: "cat",
		path: "packages/tools/src/index.ts",
		offset: 1,
		limit: 2_000,
	});
	const quotedRegex = parseBashCommand({ command: String.raw`rg "\bfoo\b"` });
	assert.equal(quotedRegex.kind, "search");
	if (quotedRegex.kind === "search") assert.equal(quotedRegex.query, String.raw`\bfoo\b`);
	const liveCommands = [
		'rg -n -i "permission" packages apps services --max-count 40',
		'rg -n -i "sandbox" packages apps services --max-count 40',
		'rg -n -i "evidence" packages tests',
		"ls packages/permissions tests packages/runtime packages/tools",
		'rg -n "tool" --heading README.md 2>/dev/null || ls',
		'rg -n -i "sandbox" packages apps services tests docs',
		'rg -n -i "verification" packages apps services tests docs | head -80',
		"ls packages/permissions packages/runtime packages/tools packages/verifiers",
	];
	for (const command of liveCommands) assert.doesNotThrow(() => parseBashCommand({ command }), command);
	const multiplePaths = parseBashCommand({ command: 'rg -n -i "permission" packages apps services --max-count 40' });
	assert.equal(multiplePaths.kind, "search");
	if (multiplePaths.kind === "search") {
		assert.deepEqual(multiplePaths.paths, ["packages", "apps", "services"]);
		assert.equal(multiplePaths.maxCount, 40);
	}
	for (const command of [
		"cat foo2>/dev/null",
		"rg token . | tail -10",
		"rg token . | xargs rm",
		"cat file > copy",
		"cat file >> copy",
		"cat < secret",
		"git status && npm test",
		"rg token &",
		"bash -c 'git status; npm test'",
		"powershell.exe -Command 'Get-ChildItem; npm test'",
		"env bash -c 'git status'",
		"busybox sh -c 'git status'",
		"echo $(whoami)",
		"echo $HOME",
		"cat ../secret",
		"cat C:\\secret.txt",
		"cat C:/secret.txt",
		"cat '//server/share/secret'",
		"cat '//?/C:/secret.txt'",
		"rg token --sort path",
	]) assert.throws(() => parseBashCommand({ command }), /bash/);
	assert.throws(() => parseBashCommand({ command: ["echo", ...Array.from({ length: 64 }, () => "x")].join(" ") }), /64-argument/);
	assert.deepEqual(bashPermissionTargets(parseBashCommand({ command: "cat first.txt second.txt" })).map(({ arguments: value }) => value.path), ["first.txt", "second.txt"]);
	assert.deepEqual(createNativeBashArgv("printf '%s\\n' ok").slice(-4), ["--noprofile", "--norc", "-c", "printf '%s\\n' ok"]);
});

test("read-only planning declines untrusted PATH resolution and ambiguous syntax", async (t) => {
	const root = await temporaryDirectory("codetonomy-bash-shadow-");
	const bin = join(root, "bin");
	await mkdir(bin);
	const fakeRg = join(bin, process.platform === "win32" ? "rg.exe" : "rg");
	await writeFile(fakeRg, "not a trusted executable");
	await chmod(fakeRg, 0o700);
	const outside = await mkdtemp(join(process.cwd(), ".codetonomy-path-shadow-"));
	const fakeCat = join(outside, process.platform === "win32" ? "cat.exe" : "cat");
	await writeFile(fakeCat, "not a trusted executable");
	await chmod(fakeCat, 0o700);
	await mkdir(join(root, ".git", "objects"), { recursive: true });
	await writeFile(join(root, ".git", "config"), "protected");
	await writeFile(join(root, "README.md"), "fixture");
	let aliasesSupported = true;
	try {
		await symlink(join(root, ".git"), join(root, "protected-alias"), process.platform === "win32" ? "junction" : "dir");
		await symlink(join(root, ".git", "objects"), join(root, "objects-alias"), process.platform === "win32" ? "junction" : "dir");
		await symlink(outside, join(root, "outside-alias"), process.platform === "win32" ? "junction" : "dir");
	} catch { aliasesSupported = false; }
	t.after(async () => { await rm(outside, { recursive: true, force: true }); });
	const previousPath = process.env.PATH;
	const previousShell = process.env.SHELL;
	const previousBash = process.env.CODETONOMY_BASH_BIN;
	try {
		process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
		const shadowed = planBashCommand({ command: "rg -F alpha ." }, root);
		assert.equal(shadowed.route, "semantic-native");
		assert.equal(shadowed.readOnly, false);
		process.env.PATH = `${outside}${delimiter}${previousPath ?? ""}`;
		assert.equal(planBashCommand({ command: "cat README.md" }, root).readOnly, false);
		if (process.platform !== "win32") {
			process.env.PATH = `"/bin"${delimiter}${outside}`;
			assert.equal(planBashCommand({ command: "cat README.md" }, root).readOnly, false);
			process.env.PATH = `"/bin"${delimiter}/bin`;
			assert.equal(planBashCommand({ command: "cat README.md" }, root).readOnly, true);
			const linkedCat = join(bin, "cat");
			await symlink("/bin/cat", linkedCat);
			process.env.PATH = `${bin}${delimiter}/bin`;
			assert.equal(planBashCommand({ command: "cat README.md" }, root).readOnly, false);
			await unlink(linkedCat);
			const emptyShadowPlan = planBashCommand({ command: "cat README.md" }, root);
			assert.equal(emptyShadowPlan.readOnly, true);
			await writeFile(linkedCat, "not a trusted executable");
			await chmod(linkedCat, 0o700);
			assert.equal(bashPlanUsesReadOnlySandbox(emptyShadowPlan, root), false);
			await unlink(linkedCat);
			process.env.PATH = `bin${delimiter}/bin`;
			assert.equal(planBashCommand({ command: "cat README.md" }, root).readOnly, true);
			const spacedBin = join(root, "space bin");
			await mkdir(spacedBin);
			await symlink("/bin/cat", join(spacedBin, "cat"));
			process.env.PATH = `${spacedBin}${delimiter}/bin`;
			assert.equal(planBashCommand({ command: "cat README.md" }, root).readOnly, false);
			const linkedBin = join(root, "linked-bin");
			await symlink("/bin", linkedBin, "dir");
			process.env.PATH = `${linkedBin}${delimiter}/bin`;
			assert.equal(planBashCommand({ command: "cat README.md" }, root).readOnly, false);
			process.env.PATH = `${linkedBin}/../bin${delimiter}/bin`;
			assert.equal(planBashCommand({ command: "cat README.md" }, root).readOnly, false);
			process.env.PATH = `/bin${delimiter}/usr/bin`;
			process.env.CODETONOMY_BASH_BIN = join(linkedBin, "bash");
			assert.equal(planBashCommand({ command: "cat README.md" }, root).readOnly, false);
			process.env.CODETONOMY_BASH_BIN = `${linkedBin}/../bin/bash`;
			assert.equal(planBashCommand({ command: "cat README.md" }, root).readOnly, false);
			delete process.env.CODETONOMY_BASH_BIN;
			const firstCwd = join(root, "first-cwd");
			const secondCwd = join(root, "second-cwd");
			const cwdAlias = join(root, "cwd-alias");
			await mkdir(firstCwd);
			await mkdir(secondCwd);
			await writeFile(join(firstCwd, "item.txt"), "first");
			await writeFile(join(secondCwd, "item.txt"), "second");
			await symlink(firstCwd, cwdAlias, "dir");
			const cwdArgs = { command: "cat item.txt", cwd: "cwd-alias" };
			const cwdPlanner = new BashCommandPlanner(root);
			const cwdPlan = cwdPlanner.plan("cwd-retarget", cwdArgs);
			assert.equal(cwdPlan.readOnly, true);
			await unlink(cwdAlias);
			await symlink(secondCwd, cwdAlias, "dir");
			assert.equal(bashPlanUsesReadOnlySandbox(cwdPlan, root), false);
			await assert.rejects(
				testBashTool(root, { planner: cwdPlanner, nativeOperationId: "inspect_workspace", allowedCanonicalToolIds: ["inspect_workspace"] }).execute("cwd-retarget", cwdArgs),
				(error: Error & { details?: Record<string, unknown> }) => error.details?.operationId === "inspect_workspace" && /changed after permission planning/.test(error.message),
			);
		}
		const cwdCat = join(root, process.platform === "win32" ? "cat.exe" : "cat");
		await writeFile(cwdCat, "not a trusted executable");
		await chmod(cwdCat, 0o700);
		process.env.PATH = `${delimiter}/bin`;
		assert.equal(planBashCommand({ command: "cat README.md" }, root).readOnly, false);
		if (process.platform !== "win32") {
			process.env.PATH = `/bin${delimiter}/usr/bin`;
			delete process.env.CODETONOMY_BASH_BIN;
			process.env.SHELL = "./bash";
			assert.equal(planBashCommand({ command: "cat README.md" }, root).readOnly, false);
			process.env.SHELL = "/bin/bash";
			process.env.CODETONOMY_BASH_BIN = "./bash";
			assert.equal(planBashCommand({ command: "cat README.md" }, root).readOnly, false);
		}
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		if (previousShell === undefined) delete process.env.SHELL;
		else process.env.SHELL = previousShell;
		if (previousBash === undefined) delete process.env.CODETONOMY_BASH_BIN;
		else process.env.CODETONOMY_BASH_BIN = previousBash;
	}
	assert.equal(planBashCommand({ command: "cat README.md" }, root).readOnly, true);
	if (process.platform !== "win32") {
		const fifo = join(root, "fixture.fifo");
		if (spawnSync("mkfifo", [fifo]).status === 0) assert.equal(planBashCommand({ command: "cat fixture.fifo" }, root).readOnly, false);
		else t.diagnostic("mkfifo unavailable; special-file planning case skipped");
	}
	for (const command of [
		"env rg alpha .", "rg --sort path", "rg -L alpha .", "rg alpha . | head -1", "cat ~/secret", "cat -- -", "head -- -", "sed -n '1p' -", "rg alpha -- -", "rg --files -- -", "rg * .", "rg -e *", "rg -g *",
		"cat .git/config", "rg x .agents", "rg --hidden x .", "rg -g '[n]ode_modules/**' secret .", "ls -a .", "head --help", `cat\u00a0README.md`, "cat /workspace/README.md",
		"cat README.md --", "head README.md --", "head README.md -n 1", "ls README.md --", "ls README.md -l", "sed -n '1p' --version", "sed -n '1p' -fattack.sed", "sed -n '1p' -i",
	]) {
		assert.equal(planBashCommand({ command }, root).readOnly, false, command);
	}
	if (aliasesSupported) {
		assert.equal(planBashCommand({ command: "cat protected-alias/config" }, root).readOnly, false);
		assert.equal(planBashCommand({ command: "cat objects-alias/../config" }, root).readOnly, false);
		assert.equal(planBashCommand({ command: `cat outside-alias/${process.platform === "win32" ? "cat.exe" : "cat"}` }, root).readOnly, false);
		assert.equal(planBashCommand({ command: "ls -l ." }, root).readOnly, false);
	}
	try {
		const outsideIgnore = join(outside, "ignore-rules");
		await writeFile(outsideIgnore, "secret-file\n");
		await symlink(outsideIgnore, join(root, ".ignore"), "file");
		assert.equal(planBashCommand({ command: "rg --files ." }, root).readOnly, false);
	} catch (error) { t.diagnostic(`Ignore-file symlink unavailable: ${(error as NodeJS.ErrnoException).code ?? error}`); }
	try {
		await link(join(root, ".git", "config"), join(root, "hardlinked-config"));
		assert.equal(planBashCommand({ command: "cat hardlinked-config" }, root).readOnly, false);
		await mkdir(join(root, "hardlink-search"));
		await link(join(root, ".git", "config"), join(root, "hardlink-search", "config"));
		assert.equal(planBashCommand({ command: "rg protected hardlink-search" }, root).readOnly, false);
	} catch (error) { t.diagnostic(`Hard links unavailable: ${(error as NodeJS.ErrnoException).code ?? error}`); }
	await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
	await writeFile(join(root, "node_modules", "pkg", "secret.txt"), "protected");
	assert.equal(planBashCommand({ command: "rg protected ." }, root).readOnly, false);
	assert.equal(planBashCommand({ command: "ls ." }, root).readOnly, false);
});

test("bash facade falls back to native Bash for valid syntax outside the accelerator grammar", async () => {
	const root = await temporaryDirectory("codetonomy-bash-native-");
	const invocation = createCodexSandboxInvocation(root, createNativeBashArgv("pwd"), { commandSandboxMode: "read-only" });
	const state = JSON.parse(invocation[2]!) as { permissionProfile: { file_system: { entries: Array<{ access: string; path: { type: string; path?: string; value?: { kind?: string } } }> }; network: string } };
	assert.ok(state.permissionProfile.file_system.entries.some(({ access, path }) => access === "read" && path.value?.kind === "project_roots"));
	assert.equal(state.permissionProfile.network, "restricted");
	assert.ok(invocation.includes("--sandbox-state-disable-network"));
	const outputStore = new CommandOutputStore({ workspaceRoot: root, outputDirectory: join(root, "private-output"), indexPath: join(root, "runs", "run-id", "tool-output-manifest.json") });
	const protectedInvocation = createCodexSandboxInvocation(root, createNativeBashArgv("pwd"), { commandSandboxMode: "workspace", privatePaths: outputStore.privatePaths() });
	const protectedState = JSON.parse(protectedInvocation[2]!) as typeof state;
	assert.ok(protectedState.permissionProfile.file_system.entries.some(({ access, path }) => access === "deny" && path.path === join(root, "runs", "run-id")));
	const nested = join(root, "nested");
	await mkdir(nested);
	const nestedInvocation = createCodexSandboxInvocation(nested, createNativeBashArgv("pwd"), { commandSandboxMode: "read-only", sandboxWorkspaceRoot: root });
	const nestedState = JSON.parse(nestedInvocation[2]!) as typeof state;
	assert.ok(nestedState.permissionProfile.file_system.entries.some(({ access, path }) => access === "deny" && path.path === join(root, ".git")));
	await writeFile(join(root, "sandbox"), "console.log(JSON.stringify(process.argv.slice(2)));\n", "utf8");
	const result = await testBashTool(root, {
		codexBinary: process.execPath,
		commandSandboxMode: "read-only",
		nativeOperationId: "run_workspace_command",
		allowedCanonicalToolIds: ["run_workspace_command"],
	}).execute("native", { command: "printf '%s\\n' tests/*.ts | tail -1" });
	assert.equal((result.details as { bashKind?: string }).bashKind, "native");
	assert.equal((result.details as { parseStatus?: string }).parseStatus, "parse-fallback");
	assert.equal((result.details as { planReason?: string }).planReason, "path-glob");
	assert.equal((result.details as { operationId?: string }).operationId, "run_workspace_command");
	assert.equal((result.details as { filesystem?: string }).filesystem, "read-only");
	assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /--noprofile/);
});

test("direct Bash reads stay bounded", async () => {
 const root = await temporaryDirectory("codetonomy-bash-bounded-");
 await writeFile(join(root, "sandbox"), "process.stdout.write('x'.repeat(100000));\n");
 const result = await testBashTool(root, { codexBinary: process.execPath }).execute("bounded", { command: "cat large.txt" });
 assert.equal((result.details as { previewTruncated: boolean }).previewTruncated, true);
 assert.equal(typeof (result.details as { outputId?: string }).outputId, "string");
 assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Output preview omitted/);
});

test("bash keeps rg literal and search_workspace is literal search only", async () => {
	const root = await temporaryDirectory("codetonomy-bash-tool-");
	await writeFile(join(root, "README.md"), "alpha needle\nbeta\n", "utf8");
	await mkdir(join(root, "packages"));
	await writeFile(join(root, "packages", "item.ts"), "export const item = true;\n", "utf8");
	await writeFile(join(root, "sandbox"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
	await writeFile(join(root, "packages", "sandbox"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
	const tool = testBashTool(root, { codexBinary: process.execPath });
	const literal = await searchWorkspaceTool(root).execute("literal", { query: "alpha needle" });
	assert.equal(literal.content[0]?.type === "text" ? literal.content[0].text : "", "README.md:1: alpha needle");
	assert.equal((literal.details as { backend?: string }).backend, "literal");
	const caseSensitive = await searchWorkspaceTool(root).execute("case-sensitive", { query: "ALPHA", caseSensitive: true });
	assert.equal(caseSensitive.content[0]?.type === "text" ? caseSensitive.content[0].text : "", "No matches found");
	const exact = await tool.execute("exact", { command: "rg -F 'alpha needle' ." });
	const nativeCommand = (result: typeof exact) => JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "").at(-1);
	assert.equal(nativeCommand(exact), "rg -F 'alpha needle' .");
	assert.equal((exact.details as { bashKind?: string }).bashKind, "native");
	const selected = await tool.execute("read", { command: "sed -n '2p' README.md" });
	assert.equal(nativeCommand(selected), "sed -n '2p' README.md");
	const decorated = await tool.execute("decorated-read", { command: "cat README.md 2>/dev/null" });
	assert.deepEqual((decorated.details as { paths?: string[] }).paths, ["README.md"]);
	const listed = await tool.execute("list", { command: "ls", cwd: "/workspace/packages" });
	assert.equal(nativeCommand(listed), "ls");
	const virtualRead = await tool.execute("virtual-read", { command: "cat /workspace/packages/item.ts", cwd: "/workspace/packages" });
	assert.equal(nativeCommand(virtualRead), "cat /workspace/packages/item.ts");
	const fileScoped = await tool.execute("file-scoped", { command: "rg alpha README.md" });
	assert.equal((fileScoped.details as { bashKind?: string }).bashKind, "native");
	await assert.rejects(tool.execute("missing-cwd", { command: "pwd", cwd: "/workspace/missing" }), /ENOENT/);
	await assert.rejects(
		testBashTool(root, { allowedCanonicalToolIds: ["list_workspace", "search_workspace", "inspect_workspace"] }).execute("denied", { command: "npm test" }),
		/unavailable.*run_workspace_command/,
	);
});

test("the tool interface defaults to structured and preserves explicit overrides", () => {
	assert.equal(resolveToolInterface({}), "structured");
	assert.equal(resolveToolInterface({ toolInterface: "bash" }), "bash");
	assert.equal(resolveToolInterface({ toolInterface: "structured" }), "structured");
});

test("Bash outcome classification separates search status from mutation risk", async (t) => {
	if (skipWithoutRipgrep(t)) return;
	const root = await temporaryDirectory("codetonomy-bash-outcomes-");
	await writeFile(join(root, "sandbox"), "const command = process.argv.at(-1); process.exit(command.includes('read-error') ? 2 : 1);\n");
	const tool = testBashTool(root, { codexBinary: process.execPath });
	const noMatch = await tool.execute("no-match", { command: "rg -F absent ." });
	assert.equal(planBashCommand({ command: "rg -F absent ." }, root).readOnly, true, JSON.stringify(planBashCommand({ command: "rg -F absent ." }, root)));
	assert.equal(noMatch.content[0]?.type === "text" ? noMatch.content[0].text : undefined, "");
	assert.deepEqual(
		Object.fromEntries(["exitCode", "resultKind", "mutationRisk", "executionOutcome", "checkpointCount"].map((key) => [key, (noMatch.details as Record<string, unknown>)[key]])),
		{ exitCode: 1, resultKind: "no-matches", mutationRisk: "none", executionOutcome: "known", checkpointCount: 0 },
	);
	const suppressedNoMatch = await tool.execute("suppressed-no-match", { command: "rg -nF absent README.md 2>/dev/null" });
	assert.equal((suppressedNoMatch.details as Record<string, unknown>).resultKind, "no-matches");
	assert.equal((suppressedNoMatch.details as Record<string, unknown>).mutationRisk, "none");
	const searchError = await tool.execute("search-error", { command: "rg -F read-error ." });
	assert.equal((searchError.details as Record<string, unknown>).resultKind, "failure");
	assert.equal((searchError.details as Record<string, unknown>).mutationRisk, "none");
	assert.equal((searchError.details as Record<string, unknown>).executionOutcome, "known");
	const filesExitOne = await tool.execute("files-exit-one", { command: "rg --files" });
	assert.equal((filesExitOne.details as Record<string, unknown>).resultKind, "failure");
	const maxCountZero = await tool.execute("max-count-zero", { command: "rg -m0 Agent README.md" });
	assert.equal((maxCountZero.details as Record<string, unknown>).resultKind, "failure");
	const writableNoMatch = await tool.execute("glob-no-match", { command: "rg -g '*.ts' absent ." });
	assert.equal((writableNoMatch.details as Record<string, unknown>).resultKind, "no-matches");
	assert.equal((writableNoMatch.details as Record<string, unknown>).mutationRisk, "possible");
	for (const command of ["npm test", "rg absent . | head -1"]) {
		const failed = await tool.execute(command, { command });
		assert.equal((failed.details as Record<string, unknown>).resultKind, "failure");
		assert.equal((failed.details as Record<string, unknown>).mutationRisk, "possible");
		assert.equal((failed.details as Record<string, unknown>).executionOutcome, "effects-unknown");
	}
});

test("bash external commands request the derived command permission", async () => {
	const root = await temporaryDirectory("codetonomy-bash-permission-");
	await writeFile(join(root, "README.md"), "permission fixture\n", "utf8");
	let approval: ToolPermissionRequest | undefined;
	const providerFetch: typeof fetch = async () => {
		const base = { id: "bash-permission", object: "chat.completion.chunk", created: 1, model: "bash-model" };
		const events = [
			{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "bash-command", type: "function", function: { name: "bash", arguments: '{"command":"npm test"}' } }] }, finish_reason: null }] },
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
		];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	const result = await createHarness().run({
		objective: "Run npm test",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "bash-provider",
		modelId: "bash-model",
		maxModelTurns: 2,
		providerConfiguration: { id: "bash-provider", name: "Bash Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
		toolInterface: "bash",
		permissionMode: "ask",
		approve: async (request) => { approval = request; return false; },
	});
	assert.equal(result.verification.passed, false);
	assert.equal(approval?.toolId, "run_workspace_command");
	assert.deepEqual(approval?.arguments, { argv: createNativeBashArgv("npm test"), cwd: ".", timeoutSeconds: 120 });
});

test("bash cannot widen a bounded write scope to external commands", async () => {
	const root = await temporaryDirectory("codetonomy-bash-ceiling-");
	let request = 0;
	let approvalRequested = false;
	const providerFetch: typeof fetch = async () => {
		request++;
		const base = { id: `bash-ceiling-${request}`, object: "chat.completion.chunk", created: 1, model: "bash-model" };
		const events = request === 1
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "bash-command", type: "function", function: { name: "bash", arguments: '{"command":"npm test"}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Unable to run the command." }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	const result = await createHarness().run({
		objective: "Update status.txt", writePaths: ["status.txt"],
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "bash-provider",
		modelId: "bash-model",
		providerConfiguration: { id: "bash-provider", name: "Bash Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
		toolInterface: "bash",
		permissionMode: "ask",
		approve: async () => { approvalRequested = true; return true; },
	});
	assert.equal(approvalRequested, false);
	assert.ok(!result.capabilities.canonicalToolIds?.includes("run_workspace_command"));
	const trace = (await readFile(result.tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
	assert.ok(trace.some(({ type, data }) => type === "tool.denied" && data.operationId === "run_workspace_command" && /unavailable/.test(String(data.reason))));
});

test("Bash command prohibitions allow precise reads and fail closed through wrappers", async (t) => {
	const root = await temporaryDirectory("codetonomy-bash-prohibition-");
	await writeFile(join(root, "README.md"), "prohibition fixture\n");
	await writeFile(join(root, "sandbox"), "require('node:fs').appendFileSync('executed.log', process.argv.at(-1) + '\\n'); process.stdout.write('fixture\\n');");
	const previousCodex = process.env.CODETONOMY_CODEX_BIN;
	process.env.CODETONOMY_CODEX_BIN = process.execPath;
	t.after(async () => {
		if (previousCodex === undefined) delete process.env.CODETONOMY_CODEX_BIN;
		else process.env.CODETONOMY_CODEX_BIN = previousCodex;
	});
	const run = async (command: string, objective = "Inspect README.md; do not run npm test") => {
		let request = 0;
		const providerFetch: typeof fetch = async () => {
			request++;
			const base = { id: `prohibition-${request}`, object: "chat.completion.chunk", created: 1, model: "bash-model" };
			const delta = request === 1
				? { role: "assistant", tool_calls: [{ index: 0, id: `prohibition-${command}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] }
				: { role: "assistant", content: "README.md contains the fixture." };
			const events = [
				{ ...base, choices: [{ index: 0, delta, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: request === 1 ? "tool_calls" : "stop" }] },
			];
			return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
		};
		return createHarness().run({
			objective,
			workspaceRoot: root,
			traceDirectory: join(root, "runs"),
			provider: "bash-provider",
			modelId: "bash-model",
			providerConfiguration: { id: "bash-provider", name: "Bash Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
			providerFetch,
			toolInterface: "bash",
			permissionMode: "auto",
			maxModelTurns: 2,
		});
	};
	assert.equal((await run("cat README.md")).verification.passed, true);
	await writeFile(join(root, "executed.log"), "");
	const allowedBuild = await run("npm build", "Run npm build; do not run npm test");
	assert.match(await readFile(join(root, "executed.log"), "utf8"), /npm build/);
	assert.doesNotMatch(await readFile(allowedBuild.tracePath, "utf8"), /Operation violates an explicit task prohibition/);
	for (const command of ["env npm test", "exec npm test", "time npm test", "nice npm test", "stdbuf -o0 npm test", "npm --silent test", "npm --prefix . test", "npm exec npm test", "./npm build"]) {
		await writeFile(join(root, "executed.log"), "");
		const blocked = await run(command);
		assert.equal(blocked.verification.passed, false, command);
		assert.equal(await readFile(join(root, "executed.log"), "utf8"), "", command);
		assert.match(await readFile(blocked.tracePath, "utf8"), /Operation violates an explicit task prohibition/, command);
	}
	await writeFile(join(root, "executed.log"), "");
	const blockedWrite = await run("printf x > forbidden.txt", "Create allowed.txt; do not write forbidden.txt");
	assert.equal(blockedWrite.verification.passed, false);
	assert.equal(await readFile(join(root, "executed.log"), "utf8"), "");
	await assert.rejects(readFile(join(root, "forbidden.txt")), /ENOENT/);
	assert.match(await readFile(blockedWrite.tracePath, "utf8"), /Operation violates an explicit task prohibition/);
});

test("bash pwd is permissioned as a read but does not satisfy workspace evidence", async (t) => {
	// A profile temp workspace exercises the Windows sandbox launch retry on fresh runners (#21).
	const root = await temporaryDirectory("codetonomy-bash-pwd-");
	let request = 0;
	const providerFetch: typeof fetch = async () => {
		request++;
		const base = { id: `bash-pwd-${request}`, object: "chat.completion.chunk", created: 1, model: "bash-model" };
		const events = request === 1
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "bash-pwd", type: "function", function: { name: "bash", arguments: '{"command":"pwd"}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "The workspace is /workspace." }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	const result = await createHarness().run({
		objective: "Inspect the workspace",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "bash-provider",
		modelId: "bash-model",
		providerConfiguration: { id: "bash-provider", name: "Bash Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
		toolInterface: "bash",
	});
	assert.equal(result.verification.checks.find(({ id }) => id === "workspace-evidence")?.passed, false);
	const trace = (await readFile(result.tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
	// Report only the tool events: the full trace is truncated in CI logs before the sandbox error.
	assert.ok(trace.some(({ type, data }) => type === "tool.completed" && data.operationId === "bash.pwd"), JSON.stringify(trace.filter(({ type }) => type.startsWith("tool."))));
});

test("bash prompt exposes its contract without driver implementation details", () => {
	const capabilities = resolveCapabilities(compileTask({ objective: "Inspect this repository" }), undefined, [], [], { presetId: "general-assistant", toolInterface: "bash" });
	assert.ok(capabilities.toolIds.includes("bash"));
	const prompt = buildStableSystemPrompt(capabilities.preset, capabilities.toolIds, capabilities.canonicalToolIds, {});
	assert.doesNotMatch(prompt, /run_workspace_command takes argv/);
	assert.doesNotMatch(prompt, /memoryDB|search_workspace|inspect_workspace/i);
	assert.match(prompt, /Bash command string/);
	assert.doesNotMatch(prompt, /driver|accelerator|fallback|translation|Trusted reads|native Bash/i);
	assert.match(prompt, /workspace is read-only/);
	const indexed = resolveCapabilities(compileTask({ objective: "Inspect this repository" }), undefined, [], [], { presetId: "general-assistant", toolInterface: "bash" });
	assert.deepEqual(indexed.toolIds, capabilities.toolIds);
	assert.equal(buildStableSystemPrompt(indexed.preset, indexed.toolIds, indexed.canonicalToolIds, {}), prompt);
	assert.ok(!capabilities.toolIds.includes("delegate_tasks"), "delegation is a module; the core never offers it");
	const specialized = resolveCapabilities(compileTask({ objective: "Update status.txt" }), undefined, [], [], { toolInterface: "bash", toolCeiling: ["list_workspace", "search_workspace", "inspect_workspace", "read_tool_output", "write_workspace", "edit_workspace"] });
	assert.ok(!specialized.canonicalToolIds?.includes("run_workspace_command"));
	assert.notEqual(specialized.toolBundleHash, capabilities.toolBundleHash);
	const codingTask = compileTask({ objective: "Implement the requested change" });
	const fullWorker = resolveCapabilities(codingTask, undefined, [], [], { toolInterface: "bash" });
	const boundedWorker = resolveCapabilities(codingTask, undefined, [], [], {
		toolInterface: "bash",
		toolCeiling: fullWorker.canonicalToolIds?.filter((id) => id !== "run_workspace_command"),
	});
	assert.notEqual(fullWorker.toolBundleHash, boundedWorker.toolBundleHash);
	assert.match(buildStableSystemPrompt(boundedWorker.preset, boundedWorker.toolIds, boundedWorker.canonicalToolIds), /only supported read commands/);
	assert.throws(() => resolveCapabilities(compileTask({ objective: "Find the requested code" }), undefined, [], [], {
		toolInterface: "bash",
		toolCeiling: ["search_workspace"],
	}), /must include read_tool_output/);
	assert.throws(() => resolveCapabilities(compileTask({ objective: "Run npm test" }), undefined, [], [], {
		toolInterface: "structured",
		toolCeiling: ["list_workspace", "search_workspace", "inspect_workspace", "run_workspace_command"],
	}), /must include read_tool_output/);
	assert.throws(
		() => resolveCapabilities(compileTask({ objective: "Run the tests" }), undefined, [], [], {
			toolInterface: "bash",
			toolCeiling: ["list_workspace", "search_workspace", "inspect_workspace"],
		}),
		/cannot satisfy: workspace-command/,
	);
});

test("workspace-write ceilings retain semantic Bash reads without command access", async (t) => {
	if (skipWithoutRipgrep(t)) return;
	const root = await temporaryDirectory("codetonomy-bash-write-ceiling-");
	await writeFile(join(root, "README.md"), "ceiling fixture\n");
	await writeFile(join(root, "sandbox"), "process.stdout.write('README.md:1:ceiling fixture\\n');");
	const previousCodex = process.env.CODETONOMY_CODEX_BIN;
	process.env.CODETONOMY_CODEX_BIN = process.execPath;
	t.after(async () => {
		if (previousCodex === undefined) delete process.env.CODETONOMY_CODEX_BIN;
		else process.env.CODETONOMY_CODEX_BIN = previousCodex;
	});
	let request = 0;
	const calls = [
		{ name: "bash", arguments: { command: "rg -F fixture README.md" } },
		{ name: "write_workspace", arguments: { path: "answer.txt", content: "done" } },
	];
	const providerFetch: typeof fetch = async () => {
		const tool = calls[request++];
		const base = { id: `ceiling-${request}`, object: "chat.completion.chunk", created: 1, model: "bash-model" };
		const delta = tool
			? { role: "assistant", tool_calls: [{ index: 0, id: `ceiling-${request}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }
			: { role: "assistant", content: "Created answer.txt after inspection." };
		const events = [
			{ ...base, choices: [{ index: 0, delta, finish_reason: null }] },
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] },
		];
		return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
	};
	const result = await createHarness().run({
		objective: "Create answer.txt after inspecting this repository",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "bash-provider",
		modelId: "bash-model",
		providerConfiguration: { id: "bash-provider", name: "Bash Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
		toolInterface: "bash",
		permissionMode: "auto",
		writePaths: ["answer.txt"],
		maxModelTurns: 3,
	});
	assert.equal(result.verification.passed, true, JSON.stringify(result.verification.checks));
	assert.equal(result.capabilities.canonicalToolIds?.includes("run_workspace_command"), false);
	assert.ok(result.capabilities.toolIds.includes("read_tool_output"));
	assert.equal(await readFile(join(root, "answer.txt"), "utf8"), "done");
});

test("new native routes preserve original command and specialized ceilings", async (t) => {
	if (skipWithoutRipgrep(t)) return;
 const root = await temporaryDirectory("codetonomy-bash-routes-");
 await writeFile(join(root, "sandbox"), "console.log(JSON.stringify(process.argv.slice(2)));");
 for (const [command, target] of [["rg alpha src", "search_workspace"], ["rg --files src", "list_workspace"], ["cat a", "inspect_workspace"]] as const) {
  const result = await testBashTool(root, { codexBinary: process.execPath, commandSandboxMode: "read-only", nativeOperationId: "inspect_workspace", allowedCanonicalToolIds: [target] }).execute(command, { command });
  const output = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.equal(JSON.parse(output).at(-1), command);
  assert.equal((result.details as { filesystem: string }).filesystem, "read-only");
 }
	assert.equal(planBashCommand({ command: "rg --files --hidden" }, root).readOnly, false);
	const unrestrictedRead = await testBashTool(root, { codexBinary: process.execPath, commandSandboxMode: "full-access", nativeOperationId: "inspect_workspace", allowedCanonicalToolIds: ["inspect_workspace"] }).execute("full-access-read", { command: "cat a" });
	assert.equal((unrestrictedRead.details as Record<string, unknown>).operationId, "inspect_workspace");
	assert.equal((unrestrictedRead.details as Record<string, unknown>).readOnly, false);
	assert.equal((unrestrictedRead.details as Record<string, unknown>).filesystem, "full-access");
 for (const command of ["rg -F -e alpha -e beta src", "rg absent src | head -1 && cat a", "rg --sort path"]) {
  const result = await testBashTool(root, { codexBinary: process.execPath, allowedCanonicalToolIds: ["run_workspace_command"] }).execute(command, { command });
  assert.equal(JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "").at(-1), command);
  await assert.rejects(testBashTool(root, { allowedCanonicalToolIds: ["search_workspace", "list_workspace", "inspect_workspace"] }).execute(command, { command }), /unavailable/);
 }
 await writeFile(join(root, ".env"), "DUMMY=synthetic");
 for (const command of ["rg --files", "rg -e alpha -e beta ."]) {
  await assert.rejects(testBashTool(root, { codexBinary: process.execPath }).execute(command, { command }), /sensitive path/);
 }
});

test("native fallback rejects parsed workspace escapes and allows paths that remain inside", async () => {
	assert.equal(planBashCommand({ command: "cat ../outside.txt" }).reason, "workspace-escape");
	await assert.rejects(testBashTool(process.cwd()).execute("escape", { command: "cat ../outside.txt" }), /escapes the workspace/);
	assert.doesNotThrow(() => parseBashCommand({ command: "cat ../../README.md", cwd: "packages/tools" }));
	const root = await temporaryDirectory("codetonomy-bash-full-access-");
	await writeFile(join(root, "sandbox"), "console.log(JSON.stringify(process.argv.slice(2)));");
	const unrestricted = await testBashTool(root, { codexBinary: process.execPath, commandSandboxMode: "full-access" }).execute("full-access", { command: "cat ../outside.txt" });
	assert.equal(JSON.parse(unrestricted.content[0]?.type === "text" ? unrestricted.content[0].text : "").at(-1), "cat ../outside.txt");
});
