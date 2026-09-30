#!/usr/bin/env node
// Install the Codetonomy sandbox that `run_workspace_command` uses: its engine is a pinned copy of the
// OpenAI Codex CLI (npm @openai/codex), installed into $CODETONOMY_WORKER_ROOT/sandbox (default
// ~/.codetonomy/workers/sandbox), where resolveSandboxBinary looks for it. It is kept separate from any
// Codex you have installed; CODETONOMY_SANDBOX_BIN selects another engine binary explicitly.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const versions = Object.fromEntries(readFileSync(join(root, "deployment", "sandbox-version.env"), "utf8").split(/\r?\n/)
	.filter(line => line && !line.startsWith("#")).map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
const workerRoot = process.env.CODETONOMY_WORKER_ROOT || join(process.env.CODETONOMY_HOME || join(homedir(), ".codetonomy"), "workers");
const target = join(workerRoot, "sandbox");

function npmCli() {
	if (process.env.npm_execpath) return process.env.npm_execpath;
	const bins = [dirname(process.execPath)];
	try { bins.push(dirname(realpathSync(process.execPath))); } catch {}
	const candidates = bins.flatMap(bin => [join(bin, "node_modules", "npm", "bin", "npm-cli.js"), join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")]);
	return candidates.find(candidate => existsSync(candidate)) ?? candidates[0];
}
const run = (program, args) => new Promise((resolve, reject) => {
	const child = spawn(program, args, { stdio: "inherit", windowsHide: true });
	child.once("error", reject);
	child.once("close", code => code === 0 ? resolve() : reject(new Error(`${program} exited ${code}`)));
});

mkdirSync(target, { recursive: true });
await run(process.execPath, [npmCli(), "install", "--prefix", target, "--save-exact", "--no-audit", "--no-fund", `@openai/codex@${versions.CODETONOMY_SANDBOX_VERSION}`]);
const integrity = JSON.parse(readFileSync(join(target, "package-lock.json"), "utf8")).packages?.["node_modules/@openai/codex"]?.integrity;
if (integrity !== versions.CODETONOMY_SANDBOX_NPM_INTEGRITY) throw new Error("The installed sandbox engine (@openai/codex) does not match the pinned integrity");
console.log(`Codetonomy sandbox ${versions.CODETONOMY_SANDBOX_VERSION} installed in ${target}`);
