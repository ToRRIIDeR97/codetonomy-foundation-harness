#!/usr/bin/env node
// Install the pinned Codex CLI that `run_workspace_command` uses as its native sandbox, into
// $CODETONOMY_WORKER_ROOT/codex (default ~/.codetonomy/workers/codex), where resolveCodexBinary looks for it.
// Set CODETONOMY_CODEX_BIN instead to use a Codex binary you already have.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const versions = Object.fromEntries(readFileSync(join(root, "deployment", "codex-version.env"), "utf8").split(/\r?\n/)
	.filter(line => line && !line.startsWith("#")).map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
const workerRoot = process.env.CODETONOMY_WORKER_ROOT || join(process.env.CODETONOMY_HOME || join(homedir(), ".codetonomy"), "workers");
const target = join(workerRoot, "codex");

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
await run(process.execPath, [npmCli(), "install", "--prefix", target, "--save-exact", "--no-audit", "--no-fund", `@openai/codex@${versions.CODETONOMY_CODEX_VERSION}`]);
const integrity = JSON.parse(readFileSync(join(target, "package-lock.json"), "utf8")).packages?.["node_modules/@openai/codex"]?.integrity;
if (integrity !== versions.CODETONOMY_CODEX_NPM_INTEGRITY) throw new Error("Installed @openai/codex does not match the pinned integrity");
console.log(`Codex CLI ${versions.CODETONOMY_CODEX_VERSION} installed in ${target}`);
