import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { planBashCommand } from "../../packages/tools/src/index.ts";

// Probes for host capabilities that some tests need. Locally a missing
// capability skips the test with its reason, so `npm test` has no expected
// failures. CI provisions every capability, so there a missing one fails the
// test instead of silently skipping it.

let ripgrep: boolean | undefined;
let symlinks: boolean | undefined;

/** A trusted `rg` that the Bash planner routes natively (on PATH or under CODETONOMY_WORKER_ROOT). */
export const trustedRipgrepAvailable = (): boolean => {
	if (ripgrep !== undefined) return ripgrep;
	const root = mkdtempSync(join(tmpdir(), "codetonomy-rg-probe-"));
	try { ripgrep = planBashCommand({ command: "rg -F probe ." }, root).readOnly === true; }
	catch { ripgrep = false; }
	finally { rmSync(root, { recursive: true, force: true }); }
	return ripgrep;
};

/** File symlinks; Windows requires Developer Mode or an elevated shell. */
export const symlinksAvailable = (): boolean => {
	if (symlinks !== undefined) return symlinks;
	const root = mkdtempSync(join(tmpdir(), "codetonomy-symlink-probe-"));
	try {
		writeFileSync(join(root, "target"), "");
		symlinkSync(join(root, "target"), join(root, "link"));
		symlinks = true;
	} catch { symlinks = false; }
	finally { rmSync(root, { recursive: true, force: true }); }
	return symlinks;
};

/** Returns true when the caller should return early because the test was skipped. */
export const skipUnless = (t: TestContext, available: boolean, reason: string): boolean => {
	if (available) return false;
	assert.ok(!process.env.CI, `${reason}; CI must provide it`);
	t.skip(reason);
	return true;
};

export const skipWithoutRipgrep = (t: TestContext): boolean =>
	skipUnless(t, trustedRipgrepAvailable(), "Trusted ripgrep unavailable (install rg on PATH or under CODETONOMY_WORKER_ROOT)");

export const skipWithoutSymlinks = (t: TestContext): boolean =>
	skipUnless(t, symlinksAvailable(), "Symlink creation unavailable (on Windows enable Developer Mode)");
