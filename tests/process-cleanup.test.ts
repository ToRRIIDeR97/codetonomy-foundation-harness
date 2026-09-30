import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { CommandOutputStore, runWorkspaceCommandTool } from "../packages/tools/src/index.ts";
import { tempDirs } from "./support/temp.ts";

const temporaryDirectory = tempDirs();

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

const processIsAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code !== "ESRCH" && code !== "ENOENT";
	}
};

const readPid = async (path: string): Promise<number> => {
	for (let attempt = 0; attempt < 200; attempt++) {
		try {
			const pid = Number((await readFile(path, "utf8")).trim());
			if (Number.isSafeInteger(pid) && pid > 0) return pid;
		} catch {}
		await delay(25);
	}
	throw new Error(`Timed out waiting for ${path}`);
};

const waitForExit = async (pid: number): Promise<void> => {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (!processIsAlive(pid)) return;
		await delay(25);
	}
	assert.equal(processIsAlive(pid), false, `process ${pid} is still alive`);
};

const killIfAlive = async (path: string): Promise<void> => {
	try {
		const pid = Number((await readFile(path, "utf8")).trim());
		if (Number.isSafeInteger(pid) && pid > 0 && processIsAlive(pid)) process.kill(pid, "SIGKILL");
	} catch {}
};

const commandRunnerSource = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

if (process.argv[2] === "grandchild") {
  writeFileSync(process.argv[3], String(process.pid));
  setInterval(() => {}, 1_000);
} else {
  const pidPath = join(process.cwd(), "command-grandchild.pid");
  const grandchild = spawn(process.execPath, [process.argv[1], "grandchild", pidPath], { stdio: "ignore", windowsHide: true });
  grandchild.unref();
  process.stdout.write("evidence before abort");
  setInterval(() => {}, 1_000);
}
`;

test("workspace command cancellation preserves evidence and terminates descendants", async () => {
	const workspace = await temporaryDirectory("codetonomy-command-process-tree-");
	const grandchildPath = join(workspace, "command-grandchild.pid");
	await writeFile(join(workspace, "sandbox"), commandRunnerSource, "utf8");
	const controller = new AbortController();
	const outputStore = new CommandOutputStore({ workspaceRoot: workspace, outputDirectory: join(workspace, "command-output") });
	try {
		const execution = runWorkspaceCommandTool(workspace, { sandboxBinary: process.execPath, commandSandboxMode: "read-only", outputStore }).execute("cancelled", { argv: ["ignored"], timeoutSeconds: 30 }, controller.signal);
		const grandchildPid = await readPid(grandchildPath);
		controller.abort();
		await assert.rejects(execution, (error: unknown) => {
			const details = (error as { details?: Record<string, unknown> }).details;
			return details?.outputComplete === false && String(details.output).includes("evidence before abort");
		});
		await waitForExit(grandchildPid);
	} finally {
		controller.abort();
		await killIfAlive(grandchildPath);
	}
});
