import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bashTool, CommandOutputStore, createNativeBashArgv, planBashCommand } from "../packages/tools/src/index.ts";

// Sanitized shapes from the 29 paid-run commands retained in bash-facade.test.ts.
// Paths, symbols, and line ranges are synthetic. Extra cases reproduce audit bugs.
export const replayCases = [
  { command: "pwd", source: "compatibility" },
  { command: "ls", source: "compatibility" },
  { command: "ls src/index.ts", source: "compatibility" },
  { command: "ls -la src", source: "compatibility" },
  { command: "ls src empty-dir", source: "compatibility" },
  { command: "ls -l src/link.ts", source: "compatibility", requiresSymlink: true },
  { command: "cat empty.txt", source: "compatibility" },
  { command: "cat crlf.txt", source: "compatibility" },
  { command: "cat no-final-newline.txt", source: "compatibility" },
  { command: "cat empty.txt no-final-newline.txt crlf.txt", source: "compatibility" },
  { command: "head --lines=2 crlf.txt", source: "compatibility" },
  { command: "sed -n '99,100p' no-final-newline.txt", source: "compatibility" },
  { command: "rg -F -e alpha -e beta src", source: "regression" },
  { command: "rg -F --regexp alpha --regexp=beta src", source: "regression" },
  { command: "rg -F -ealpha --regexp beta src", source: "regression" },
  // Ask rg for a stable order so two native executions can be compared byte-for-byte.
  { command: "rg --files --sort path src", source: "regression" },
  { command: "rg --files --sort path --hidden src", source: "regression" },
  { command: "rg --files --sort path -g '*.ts' src", source: "regression" },
  { command: "rg -nF alpha src", source: "regression" },
  { command: "rg -nF 'two words' 'src/space name.ts'", source: "regression" },
  { command: "rg -nF absent src", source: "regression" },
  { command: "rg -nF absent src | head -1 && printf 'pipeline passed\\n'", source: "regression" },
  { command: "rg -nF absent src || printf 'fallback\\n'", source: "regression" },
  { command: "rg -nF alpha missing 2>/dev/null", source: "regression" },
  { command: "rg -n -i 'permission' src --max-count 40", source: "observed" },
  { command: "rg -n -i 'sandbox|permission' src/index.ts | head -6", source: "observed" },
  { command: "rg -l -i 'permission' --type ts src | head -4", source: "observed" },
  { command: "cat README.md | head -10", source: "observed" },
  { command: "sed -n '1,12p' src/index.ts", source: "observed", read: "src/index.ts:1-12" },
  { command: "sed -n '1,12p' src/index.ts", source: "observed", read: "src/index.ts:1-12" },
  { command: "cat src/index.ts", source: "context-volume", read: "src/index.ts:all" },
  { command: "git rev-parse --is-inside-work-tree && git log --oneline -1", source: "observed" },
  { command: "printf '%s\\n' src/*.ts | tail -1", source: "observed" },
  { command: "head -n 3 'src/space name.ts'", source: "regression" },
] as const;

export async function replayBash() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codetonomy-bash-replay-")));
  const outputRoot = await mkdtemp(join(tmpdir(), "codetonomy-bash-replay-output-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "empty-dir"));
    // rg honors gitignore only inside a repository. No user config or hooks needed.
    const git = spawnSync("git", ["init", "--quiet", root], { encoding: "utf8" });
    const argv = createNativeBashArgv("command -v rg && command -v head && command -v sed && command -v git");
    const probe = spawnSync(argv[0]!, argv.slice(1), { cwd: root, encoding: "utf8" });
    if (git.status !== 0 || probe.status !== 0) return { skipped: true, reason: "Native Bash/rg/head/sed/git unavailable", rows: [] };
    await writeFile(join(root, ".gitignore"), "src/ignored.ts\n");
    await writeFile(join(root, "README.md"), "Synthetic replay fixture\n");
    await writeFile(join(root, "src/index.ts"), Array.from({ length: 600 }, (_, i) => `${i % 2 ? "beta" : "alpha"} permission sandbox line ${i + 1}`).join("\n") + "\n");
    await writeFile(join(root, "src/space name.ts"), "two words\nsecond\nthird\n");
    await writeFile(join(root, "src/ignored.ts"), "alpha ignored\n");
    await writeFile(join(root, "src/.hidden.ts"), "alpha hidden\n");
    await writeFile(join(root, "empty.txt"), "");
    await writeFile(join(root, "crlf.txt"), "first\r\nsecond\r\nthird\r\n");
    await writeFile(join(root, "no-final-newline.txt"), "no final newline");
    let symlinkSupported = true;
    try { await symlink("index.ts", join(root, "src/link.ts")); }
    catch { symlinkSupported = false; }
    // Full access is only for synthetic compatibility replay. This is not a sandbox test.
    const outputStore = new CommandOutputStore({ workspaceRoot: root, outputDirectory: join(outputRoot, "capture") });
    const tool = bashTool(root, { commandSandboxMode: "full-access", outputStore });
    const seen = new Set<string>();
    const rows = [];
    for (const [index, entry] of replayCases.entries()) {
      if ("requiresSymlink" in entry && entry.requiresSymlink && !symlinkSupported) continue;
      const plan = planBashCommand(entry, root);
      const nativeArgv = createNativeBashArgv(entry.command);
      const reference = spawnSync(nativeArgv[0]!, nativeArgv.slice(1), { cwd: root, encoding: "utf8", timeout: 10_000 });
      const started = performance.now();
      try {
        const result = await tool.execute(`replay-${index}`, entry);
        const durationMs = performance.now() - started;
        const details = result.details as Record<string, unknown>;
        let output = "";
        if (typeof details.outputId === "string") {
          let offset = 0;
          while (true) {
            const range = await outputStore.read(details.outputId, offset, 16 * 1024);
            output += range.text;
            if (range.nextOffset === undefined) break;
            offset = range.nextOffset;
          }
        } else if (details.capturedBytes !== 0) {
          output = result.content[0]?.type === "text" ? result.content[0].text : "";
        }
        const expected = reference.stdout + reference.stderr;
        const exitCode = details.exitCode;
        const key = "read" in entry ? `${entry.read}:${createHash("sha256").update(output).digest("hex")}` : undefined;
        const repeatedRead = key ? seen.has(key) : false;
        if (key) seen.add(key);
        rows.push({ ...entry, parseStatus: details.parseStatus, planReason: details.planReason, correct: !reference.error && output === expected && exitCode === reference.status && details.outputComplete === true, durationMs, outputBytes: Buffer.byteLength(output), exitCode, resultKind: details.resultKind, toolError: details.resultKind === "failure", repeatedRead, indexedSearchUse: 0 });
      } catch (error) {
        rows.push({ ...entry, parseStatus: plan.route, planReason: plan.reason, correct: false, durationMs: performance.now() - started, outputBytes: 0, toolError: true, repeatedRead: false, indexedSearchUse: 0, error: String(error) });
      }
    }
    return { skipped: false, platform: process.platform, providerTokens: null, symlinkSupported, note: "Output bytes are context-volume proxies, not provider token measurements. Native replay uses synthetic full-access fixtures; security is tested separately.", rows };
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outputRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await replayBash();
  console.log(JSON.stringify(report, null, 2));
  if (!report.skipped && report.rows.some(row => !row.correct)) process.exitCode = 1;
}
