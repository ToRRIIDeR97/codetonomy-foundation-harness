import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, type TestContext } from "node:test";

// Test temp directories live under os.tmpdir() and are removed after use.
// CODETONOMY_KEEP_TEST_TMP=1 keeps them for debugging.
const create = async (prefix: string): Promise<string> => realpath(await mkdtemp(join(tmpdir(), prefix)));

async function remove(path: string): Promise<void> {
	if (process.env.CODETONOMY_KEEP_TEST_TMP === "1") return;
	// Timed-out commands can briefly outlive their timeout on Windows (#22), so removal retries.
	// A directory that still cannot be removed is reported, not failed: leak checks catch real leftovers.
	try { await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); }
	catch (error) { process.emitWarning(`Could not remove test directory ${path}: ${(error as Error).message}`); }
}

/** A directory for test `t`, removed when `t` ends, whether it passes or fails. */
export async function tempDir(t: TestContext, prefix: string): Promise<string> {
	const path = await create(prefix);
	t.after(() => remove(path));
	return path;
}

/** Call at module top level: the result creates a directory with the given prefix, and all are removed after the file's tests. */
export function tempDirs(): (prefix: string) => Promise<string> {
	const created: string[] = [];
	after(async () => { for (const path of created) await remove(path); });
	return async (prefix) => {
		const path = await create(prefix);
		created.push(path);
		return path;
	};
}

/** Call at module top level: each call of the result creates a directory, and all are removed after the file's tests. */
export function tempDirFactory(prefix: string): () => Promise<string> {
	const make = tempDirs();
	return () => make(prefix);
}
