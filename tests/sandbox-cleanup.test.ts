// The Linux sandbox leaves nothing that breaks later runs: the shared command-output root exists
// before any sandbox denies it, a stale bubblewrap placeholder there is replaced, and a command the
// harness terminates leaves no mount placeholders in the temp directory.
// Ported from codetonomy Implementations/linux-sandbox-cleanup (PR 60).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { tempDir } from "./support/temp.ts";

const root = resolve(import.meta.dirname, "..");
const tsx = import.meta.resolve("tsx");

// COMMAND_OUTPUT_ROOT is fixed from tmpdir() at import, so each check runs in a child with its own TMPDIR.
const runWithTemp = (tmp: string, script: string): Promise<{ code: number | null; output: string }> => new Promise((done, reject) => {
	const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
	delete env.NODE_TEST_CONTEXT;
	delete env.NODE_OPTIONS;
	const child = spawn(process.execPath, ["--import", tsx, "--input-type=module", "-e", script], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout.on("data", (chunk) => { output += String(chunk); });
	child.stderr.on("data", (chunk) => { output += String(chunk); });
	child.once("error", reject);
	child.once("close", (code) => done({ code, output }));
});
const tools = JSON.stringify(join(root, "packages/tools/src/index.ts"));

test("AC-1: a stale empty placeholder at the output root is replaced by a private directory; other files are refused", async (t) => {
	const tmp = await tempDir(t, "sandbox-cleanup-root-");
	const replaced = await runWithTemp(tmp, `
		import { writeFileSync, chmodSync, lstatSync } from "node:fs";
		import { join } from "node:path";
		import { tmpdir } from "node:os";
		const path = join(tmpdir(), ".codetonomy-output");
		writeFileSync(path, ""); chmodSync(path, 0o444);
		const { ensureCommandOutputRoot } = await import(${tools});
		await ensureCommandOutputRoot();
		const info = lstatSync(path);
		console.log(JSON.stringify({ directory: info.isDirectory(), mode: (info.mode & 0o777).toString(8) }));
	`);
	assert.equal(replaced.code, 0, replaced.output);
	const result = JSON.parse(replaced.output.trim().split("\n").at(-1)!) as { directory: boolean; mode: string };
	assert.equal(result.directory, true, "the placeholder became a directory");
	if (process.platform !== "win32") assert.equal(result.mode, "700", "the directory is private");

	const other = await tempDir(t, "sandbox-cleanup-other-");
	const refused = await runWithTemp(other, `
		import { writeFileSync } from "node:fs";
		import { join } from "node:path";
		import { tmpdir } from "node:os";
		writeFileSync(join(tmpdir(), ".codetonomy-output"), "not a placeholder");
		const { ensureCommandOutputRoot } = await import(${tools});
		await ensureCommandOutputRoot().then(() => console.log("created"), (error) => console.log("refused:", error.code ?? error.message));
	`);
	assert.match(refused.output, /refused: EEXIST/, "a non-empty file is never removed");
});

test("AC-2: on Linux, commands the harness times out leave no sandbox mount placeholders in the temp directory", { skip: process.platform !== "linux" || !process.env.CODETONOMY_CODEX_BIN ? "needs the Linux Codex sandbox" : false }, async (t) => {
	const tmp = await tempDir(t, "sandbox-cleanup-kill-");
	const run = await runWithTemp(tmp, `
		import { mkdtempSync } from "node:fs";
		import { join } from "node:path";
		import { tmpdir } from "node:os";
		const { runWorkspaceCommandTool, CommandOutputStore } = await import(${tools});
		const workspace = mkdtempSync(join(tmpdir(), "workspace-"));
		const tool = runWorkspaceCommandTool(workspace, { outputStore: new CommandOutputStore({ workspaceRoot: workspace, outputDirectory: join(tmpdir(), "capture") }) });
		for (let attempt = 0; attempt < 4; attempt++) {
			await tool.execute("slow-" + attempt, { argv: ["node", "-e", "setTimeout(() => {}, 8000)"], cwd: ".", timeoutSeconds: 1 }).then(() => { throw new Error("expected a timeout"); }, (error) => { if (!/timed out/.test(error.message)) throw error; });
		}
		console.log("done");
	`);
	assert.equal(run.code, 0, run.output);
	const left = (await readdir(tmp)).filter((name) => [".git", ".codex", ".agents"].includes(name));
	assert.deepEqual(left, [], "no bubblewrap mount placeholders remain");
});
