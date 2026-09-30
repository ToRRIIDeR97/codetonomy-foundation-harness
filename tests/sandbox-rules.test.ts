// Secret files are hidden inside the Codetonomy sandbox instead of refusing commands, home-folder
// credential stores are denied, redundant read rules are dropped, and command snapshots reuse
// unchanged pre-images while reporting the same changes and rewinding the same way.
// Ported from Codetonomy's sandbox-rules-fast-snapshot acceptance tests.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, sep } from "node:path";
import test from "node:test";
import { RunCheckpoint, rewindCheckpoint } from "../packages/runtime/src/checkpoint.ts";
import { sandboxHome, CommandOutputStore, createSandboxInvocation, homeSecretPaths, resolveSandboxBinary, runWorkspaceCommandTool, secretFileDenyEntries } from "../packages/tools/src/index.ts";
import { planBashCommand } from "../packages/tools/src/index.ts";
import { tempDir } from "./support/temp.ts";

const posix = process.platform !== "win32";
const outputStore = (workspaceRoot: string) => new CommandOutputStore({ workspaceRoot, outputDirectory: join(workspaceRoot, `.command-output-${randomUUID()}`) });
type Entry = { access: string; path: { type: string; path?: string; pattern?: string } };
const policyEntries = (workspace: string, commandSandboxMode: "workspace" | "read-only" = "workspace"): Entry[] => {
	const args = createSandboxInvocation(workspace, [process.execPath], { commandSandboxMode, sandboxWorkspaceRoot: workspace });
	return JSON.parse(args[args.indexOf("--sandbox-state-json") + 1]!).permissionProfile.file_system.entries;
};
const within = (parent: string, child: string): boolean => { const path = relative(parent, child); return path === "" || (!path.startsWith("..") && !isAbsolute(path)); };
const withEnvironment = async <T>(changes: Record<string, string | undefined>, action: () => Promise<T>): Promise<T> => {
	const previous = Object.fromEntries(Object.keys(changes).map((name) => [name, process.env[name]]));
	for (const [name, value] of Object.entries(changes)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
	try { return await action(); }
	finally { for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value; }
};

test("AC-1: secret files are hidden by pattern and the command runs", async (t) => {
	const workspace = await tempDir(t, "codetonomy-secret-patterns-");
	await mkdir(join(workspace, "app", "node_modules", "pkg"), { recursive: true });
	for (const file of [".env", "app/.env.local", "app/node_modules/pkg/.env"]) await writeFile(join(workspace, file), "DUMMY=fixture");
	await writeFile(join(workspace, "sandbox"), "console.log('ran');");
	const execute = () => runWorkspaceCommandTool(workspace, { sandboxBinary: process.execPath, outputStore: outputStore(workspace) }).execute("secrets", { argv: ["ignored"] });
	if (!posix) {
		await assert.rejects(execute, /commands are blocked.*sensitive path/);
		return;
	}
	const result = await execute();
	assert.equal((result.details as { exitCode: number }).exitCode, 0);
	const patterns = policyEntries(workspace).filter(({ access, path }) => access === "deny" && path.type === "glob_pattern" && path.pattern!.startsWith(`${workspace}/`)).map(({ path }) => path.pattern!);
	assert.ok(patterns.length > 0 && patterns.every((pattern) => pattern.startsWith(`${workspace}/**/`)));
	for (const expected of [".[eE][nN][vV]", ".[eE][nN][vV].*", ".[sS][sS][hH]/**", "*.{[kK][eE][yY],[pP][eE][mM],[pP]12,[pP][fF][xX],[kK][eE][yY][sS][tT][oO][rR][eE]}"]) {
		assert.ok(patterns.includes(`${workspace}/**/${expected}`), expected);
	}
	for (const mode of ["workspace", "read-only"] as const) {
		assert.deepEqual(secretFileDenyEntries(workspace)?.map(({ path }) => path.pattern), policyEntries(workspace, mode).filter(({ path }) => path.type === "glob_pattern" && path.pattern!.startsWith(`${workspace}/`)).map(({ path }) => path.pattern));
	}
});

test("AC-2: a workspace root containing glob syntax keeps the refusal", { skip: !posix }, async (t) => {
	const parent = await tempDir(t, "codetonomy-glob-root-");
	const workspace = join(parent, "project[1]");
	await mkdir(workspace);
	await writeFile(join(workspace, ".env"), "DUMMY=fixture");
	assert.equal(secretFileDenyEntries(workspace), undefined);
	await assert.rejects(() => runWorkspaceCommandTool(workspace, { sandboxBinary: process.execPath, outputStore: outputStore(workspace) })
		.execute("glob-root", { argv: ["ignored"] }), /commands are blocked.*sensitive path/);
	assert.equal(policyEntries(workspace).some(({ path }) => path.type === "glob_pattern" && path.pattern!.startsWith(parent)), false);
});

// macOS denies the home stores with one glob of alternatives (each with its contents); other
// platforms use one rule per existing path.
const homeDenied = (entries: Entry[], home: string, path: string): boolean => entries.some(({ access, path: target }) => access === "deny"
	&& (target.path === path || (target.type === "glob_pattern" && target.pattern!.startsWith(`${home}/{`)
		&& target.pattern!.slice(home.length + 2, -1).split(",").includes(relative(home, path).split(sep).join("/")))));

test("AC-3: home credential stores are denied unless they contain the workspace", async (t) => {
	const home = await tempDir(t, "codetonomy-fake-home-");
	const nested = join(home, ".aws", "project");
	await mkdir(nested, { recursive: true });
	await mkdir(join(home, ".ssh"));
	await mkdir(join(home, "sandbox-home"));
	await writeFile(join(home, "sandbox-home", "auth.json"), "{}");
	const workspace = await tempDir(t, "codetonomy-home-denies-");
	await withEnvironment({ HOME: home, USERPROFILE: home, CODEX_HOME: join(home, "sandbox-home") }, async () => {
		const outside = policyEntries(workspace);
		for (const path of [join(home, ".ssh"), join(home, ".aws"), join(home, "sandbox-home", "auth.json")]) assert.ok(homeDenied(outside, home, path), path);
		if (process.platform === "darwin") {
			for (const path of homeSecretPaths().filter((path) => within(home, path))) assert.ok(homeDenied(outside, home, path), path);
			const glob = outside.find(({ path }) => path.type === "glob_pattern" && path.pattern!.startsWith(`${home}/{`))!.path.pattern!;
			assert.ok(glob.includes(",.ssh/**,"), "folder contents are denied too");
		} else {
			assert.equal(homeDenied(outside, home, join(home, ".gnupg")), false, "missing paths need no rule");
		}
		const inside = policyEntries(nested);
		assert.equal(homeDenied(inside, home, join(home, ".aws")), false);
		assert.ok(homeDenied(inside, home, join(home, ".ssh")));
		assert.equal(inside.some(({ access, path }) => access === "deny" && path.type === "path" && within(path.path!, nested)), false);
	});
});

test("AC-4: no toolchain read rule is redundant unless it narrows a broader grant", async (t) => {
	const workspace = await tempDir(t, "codetonomy-redundant-reads-");
	for (const mode of ["workspace", "read-only"] as const) {
		const entries = policyEntries(workspace, mode);
		// The workspace's own entries are kept as listed; only toolchain (PATH) reads are trimmed.
		const reads = entries.filter(({ access, path }) => access === "read" && path.type === "path" && !within(workspace, path.path!)).map(({ path }) => path.path!);
		const narrowing = entries.filter(({ access, path }) => access !== "read" && path.type === "path").map(({ path }) => path.path!);
		const writableTemp = mode === "read-only" ? [] : [await realpath(tmpdir()), "/tmp", "/private/tmp"];
		for (const [index, path] of reads.entries()) {
			const covered = reads.some((other, otherIndex) => otherIndex !== index && within(other, path));
			if (covered) assert.ok([...narrowing, ...writableTemp].some((root) => within(root, path)), `${path} is redundant`);
		}
		assert.equal(new Set(reads).size, reads.length);
	}
});

const sandboxBinary = process.env.CODETONOMY_SANDBOX_BIN ? resolveSandboxBinary(process.env.CODETONOMY_SANDBOX_BIN) : resolveSandboxBinary();
const sandboxVersion = spawnSync(sandboxBinary, ["--version"], { encoding: "utf8" }).stdout?.trim().split(/\s+/).at(-1) ?? "";
const [major = 0, minor = 0, patch = 0] = sandboxVersion.split(".").map(Number);
const supportsPatternDenies = major > 0 || minor > 159 || (minor === 159 && patch >= 2);
const sandboxRequired = process.env.CI === "true" || process.env.CODETONOMY_REQUIRE_SANDBOX === "1";

test("AC-5: the real sandbox hides secret files and home credentials", { skip: !posix || (!supportsPatternDenies && !sandboxRequired) }, async (t) => {
	assert.ok(supportsPatternDenies, `Sandbox engine ${sandboxVersion || "(missing)"} at ${sandboxBinary} is older than 0.159.2`);
	// Outside the system temp folders: the macOS sandbox refuses overlapping state there.
	const parent = await mkdtemp(join(process.cwd(), ".codetonomy-sandbox-"));
	t.after(() => rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
	const workspace = join(parent, "workspace");
	const home = join(parent, "home");
	for (const directory of ["app/node_modules/pkg", "certs", "config"]) await mkdir(join(workspace, directory), { recursive: true });
	for (const directory of [".ssh", ".codex", ".config/gh"]) await mkdir(join(home, directory), { recursive: true });
	const secrets = [".env", "app/.ENV.local", "app/node_modules/pkg/.env", "certs/Server.PEM", "config/secrets.json"];
	for (const file of secrets) await writeFile(join(workspace, file), "SECRET=fixture\n");
	await writeFile(join(workspace, "README.md"), "readable\n");
	const homeSecrets = [".ssh/id_rsa", ".codex/auth.json", ".config/gh/hosts.yml"];
	for (const file of homeSecrets) await writeFile(join(home, file), "SECRET=fixture\n");

	await withEnvironment({ HOME: home, CODEX_HOME: undefined, CODETONOMY_HOME: join(parent, "codetonomy") }, async () => {
		const tool = runWorkspaceCommandTool(workspace, { sandboxBinary, commandSandboxMode: "workspace", outputStore: new CommandOutputStore({ workspaceRoot: workspace, outputDirectory: join(parent, "output") }) });
		const run = async (script: string): Promise<{ exitCode: number; output: string }> => {
			const result = await tool.execute("probe", { argv: ["/bin/sh", "-c", script] });
			return { exitCode: (result.details as { exitCode: number }).exitCode, output: result.content[0]?.type === "text" ? result.content[0].text : "" };
		};
		assert.equal((await run("cat README.md")).exitCode, 0);
		// Linux may mask a denied file as empty instead of failing the read, so only content is asserted.
		for (const file of secrets) assert.doesNotMatch((await run(`cat '${file}'`)).output, /SECRET=fixture/, file);
		for (const [name, script] of [
			["symlink", "ln -s .env via-link && cat via-link"],
			["hard link", "ln .env via-hard && cat via-hard"],
			["rename", "mv .env moved && cat moved"],
			["copy", "cp .env copied && cat copied"],
		] as const) assert.doesNotMatch((await run(script)).output, /SECRET=fixture/, name);
		await run("printf OVERWRITTEN > .env");
		assert.equal(await readFile(join(workspace, ".env"), "utf8"), "SECRET=fixture\n");
		assert.equal((await run("printf ok > created.txt && cat created.txt")).exitCode, 0);
		for (const file of homeSecrets) assert.doesNotMatch((await run(`cat "$HOME/${file}"`)).output, /SECRET=fixture/, file);
	});
});

test("AC-6: command snapshots report the same changes and rewind across commands", async (t) => {
	const workspace = await tempDir(t, "codetonomy-snapshot-parity-");
	const state = await tempDir(t, "codetonomy-snapshot-parity-state-");
	const files: Record<string, string> = { "a.txt": "a", "b.txt": "b", "c.txt": "c", "touched.txt": "t", "same-mtime.txt": "m", "script.sh": "echo" };
	for (const [file, content] of Object.entries(files)) await writeFile(join(workspace, file), content);
	if (posix) await symlink("a.txt", join(workspace, "link"));
	const scriptMode = (await lstat(join(workspace, "script.sh"))).mode & 0o777;
	const checkpointPath = join(state, "checkpoint.json");
	const checkpoint = new RunCheckpoint(workspace, "parity", checkpointPath);

	await checkpoint.beforeWorkspace();
	await writeFile(join(workspace, "a.txt"), "a2");
	await writeFile(join(workspace, "new.txt"), "new");
	await unlink(join(workspace, "b.txt"));
	const touched = new Date(Date.now() + 5_000);
	await utimes(join(workspace, "touched.txt"), touched, touched);
	const { atime, mtime } = await lstat(join(workspace, "same-mtime.txt"));
	await writeFile(join(workspace, "same-mtime.txt"), "n");
	await utimes(join(workspace, "same-mtime.txt"), atime, mtime);
	if (posix) {
		await chmod(join(workspace, "script.sh"), 0o755);
		await unlink(join(workspace, "link"));
		await symlink("c.txt", join(workspace, "link"));
	}
	const first = await checkpoint.afterWorkspace();
	assert.deepEqual(new Set(first), new Set(["a.txt", "new.txt", "b.txt", "same-mtime.txt", ...(posix ? ["script.sh", "link"] : [])]));

	await checkpoint.beforeWorkspace();
	await writeFile(join(workspace, "c.txt"), "c2");
	await writeFile(join(workspace, "a.txt"), "a3");
	assert.deepEqual(new Set(await checkpoint.afterWorkspace()), new Set(["c.txt", "a.txt"]));
	assert.equal(checkpoint.workspaceCaptureComplete(), true);

	await rewindCheckpoint(checkpointPath, workspace);
	for (const [file, content] of Object.entries(files)) assert.equal(await readFile(join(workspace, file), "utf8"), content, file);
	await assert.rejects(() => lstat(join(workspace, "new.txt")), { code: "ENOENT" });
	if (posix) {
		assert.equal((await lstat(join(workspace, "script.sh"))).mode & 0o777, scriptMode);
		assert.equal(await readlink(join(workspace, "link")), "a.txt");
	}
});

test("AC-7: later commands reuse unchanged pre-images and re-read racy files", async (t) => {
	const workspace = await tempDir(t, "codetonomy-snapshot-cache-");
	const state = await tempDir(t, "codetonomy-snapshot-cache-state-");
	for (let index = 0; index < 50; index++) await writeFile(join(workspace, `settled-${index}.txt`), `${index}`);
	// Setting timestamps also updates ctime, so settled files must be left alone past the racy window.
	await new Promise((resolve) => setTimeout(resolve, 2_500));
	await writeFile(join(workspace, "racy.txt"), "fresh");
	const checkpoint = new RunCheckpoint(workspace, "cache", join(state, "checkpoint.json"));
	await checkpoint.beforeWorkspace();
	assert.deepEqual(checkpoint.lastWorkspaceCapture, { files: 51, read: 51, reused: 0 });
	assert.deepEqual(await checkpoint.afterWorkspace(), []);

	await checkpoint.beforeWorkspace();
	assert.deepEqual(checkpoint.lastWorkspaceCapture, { files: 51, read: 1, reused: 50 });
	await writeFile(join(workspace, "settled-0.txt"), "changed");
	assert.deepEqual(await checkpoint.afterWorkspace(), ["settled-0.txt"]);

	// The checkpoint now holds settled-0's run-start pre-image, so it is neither read nor reused;
	// the still-racy file is read again and the other 49 are reused.
	await checkpoint.beforeWorkspace();
	assert.deepEqual(checkpoint.lastWorkspaceCapture, { files: 51, read: 1, reused: 49 });
	await checkpoint.afterWorkspace();
});

test("AC-8: a workspace above the former 20,000-file limit is snapshotted", async (t) => {
	const workspace = await tempDir(t, "codetonomy-snapshot-large-");
	const state = await tempDir(t, "codetonomy-snapshot-large-state-");
	await mkdir(join(workspace, "src"));
	for (let start = 0; start < 20_100; start += 500) {
		await Promise.all(Array.from({ length: Math.min(500, 20_100 - start) }, (_, offset) => writeFile(join(workspace, "src", `${start + offset}.txt`), "")));
	}
	const checkpoint = new RunCheckpoint(workspace, "large", join(state, "checkpoint.json"));
	await checkpoint.beforeWorkspace();
	await writeFile(join(workspace, "src", "20099.txt"), "changed");
	assert.deepEqual(await checkpoint.afterWorkspace(), [join("src", "20099.txt")]);
	assert.equal(checkpoint.workspaceCaptureComplete(), true);
});

test("AC-9: the sandbox never falls back to the user's own Codex on PATH or the desktop app", async (t) => {
	const root = await tempDir(t, "codetonomy-no-user-codex-");
	const bin = join(root, "bin");
	const desktop = join(root, "OpenAI", "Codex", "bin", "1.0.0");
	await mkdir(bin);
	await mkdir(desktop, { recursive: true });
	const userCodex = join(bin, process.platform === "win32" ? "codex.cmd" : "codex");
	await writeFile(userCodex, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
	if (posix) await chmod(userCodex, 0o755);
	await writeFile(join(desktop, "codex.exe"), "desktop app candidate");
	const workers = join(root, "workers");
	const workspace = join(root, "workspace");
	await mkdir(workspace);
	// Every Codetonomy worker root points into this test, so a real install on the host is not found either.
	await withEnvironment({ PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, CODETONOMY_SANDBOX_BIN: undefined, CODETONOMY_WORKER_ROOT: workers,
		CODETONOMY_HOME: join(root, "configuration"), HOME: root, USERPROFILE: root, LOCALAPPDATA: root }, async () => {
		const resolved = resolveSandboxBinary();
		assert.ok(within(workers, resolved), resolved);
		await assert.rejects(() => runWorkspaceCommandTool(workspace, { outputStore: outputStore(workspace) }).execute("missing", { argv: ["ignored"] }),
			/Codetonomy sandbox is not installed.*install-sandbox/);
	});
});

test("AC-10: the sandbox runs with Codetonomy's own CODEX_HOME, not the user's", async (t) => {
	const root = await tempDir(t, "codetonomy-sandbox-home-");
	const workspace = join(root, "workspace");
	await mkdir(workspace);
	await writeFile(join(workspace, "sandbox"), "console.log(process.env.CODEX_HOME);");
	const workers = join(root, "workers");
	await withEnvironment({ CODETONOMY_WORKER_ROOT: workers, CODEX_HOME: join(root, "personal-codex") }, async () => {
		assert.equal(sandboxHome(), join(workers, "sandbox-home"));
		const result = await runWorkspaceCommandTool(workspace, { sandboxBinary: process.execPath, outputStore: outputStore(workspace) }).execute("home", { argv: ["ignored"] });
		assert.equal((result.content[0]?.type === "text" ? result.content[0].text : "").trim(), sandboxHome());
		if (posix) assert.equal((await lstat(sandboxHome())).mode & 0o777, 0o700);
	});
});

test("AC-12: tools in Codetonomy's default worker root are trusted without CODETONOMY_WORKER_ROOT", { skip: !posix }, async (t) => {
	// Outside the system temp folders, which never hold trusted tools.
	const parent = await mkdtemp(join(process.cwd(), ".codetonomy-trust-"));
	t.after(() => rm(parent, { recursive: true, force: true }));
	const configuration = join(parent, "configuration");
	const tools = join(configuration, "workers", "tools");
	const workspace = join(parent, "workspace");
	await mkdir(tools, { recursive: true });
	await mkdir(workspace);
	await writeFile(join(tools, "rg"), "#!/bin/sh\n");
	await chmod(join(tools, "rg"), 0o755);
	const search = () => planBashCommand({ command: "rg -F probe ." }, workspace).readOnly;
	await withEnvironment({ PATH: `${tools}${delimiter}/usr/bin${delimiter}/bin`, CODETONOMY_WORKER_ROOT: undefined, CODETONOMY_HOME: configuration }, async () => {
		assert.equal(search(), true);
	});
	await withEnvironment({ PATH: `${tools}${delimiter}/usr/bin${delimiter}/bin`, CODETONOMY_WORKER_ROOT: undefined, CODETONOMY_HOME: join(parent, "elsewhere") }, async () => {
		assert.equal(search(), false, "a tool outside Codetonomy's worker roots is not trusted");
	});
});
