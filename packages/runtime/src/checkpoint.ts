import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, readdir, readlink, symlink, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 256 * 1024 * 1024;
const MAX_CHECKPOINT_FILES = 100_000;
// ponytail: command rewind remains a bounded full-workspace snapshot; unchanged pre-images stay in memory for the run.
// Each excluded name is skipped as a whole, not only its contents: the Linux Codetonomy sandbox
// creates empty mount targets for protected names, and a killed sandbox can leave them behind.
const CHECKPOINT_EXCLUDED_NAMES = new Set([".git", ".agents", ".codex", ".codetonomy", ".harness", ".pnpm-store", ".reference-repos", "dist", "node_modules"]);
// A cached state is reused only for files whose timestamps predate its capture by this much, so a write
// landing in the same timestamp tick on a coarse filesystem (FAT: 2 s) is still read (racy-git rule).
const RACY_WINDOW_MS = 2_000;
const CAPTURE_CONCURRENCY = 32;

interface FileState {
	existed: boolean;
	mode?: number;
	sha256?: string;
	content?: string;
	kind?: "file" | "symlink";
	link?: string;
	identity?: string;
}

interface FileSnapshot extends FileState {
	path: string;
	after?: Omit<FileState, "content">;
}

interface CheckpointFile {
	version: 1;
	workspace: string;
	runId: string;
	createdAt: number;
	files: FileSnapshot[];
	coverageFailures?: Array<{ path: string; reason: string }>;
	commandScope?: boolean;
}

export interface RewindResult {
	restored: string[];
	deleted: string[];
	coverage?: "captured" | "incomplete";
	residual?: string[];
}

export interface CheckpointPreview {
	files: string[];
	diff: string;
}

const hash = (content: Buffer): string => createHash("sha256").update(content).digest("hex");

async function loadCheckpoint(checkpointPath: string, workspaceRoot: string): Promise<{ workspace: string; files: FileSnapshot[]; coverageFailures: Array<{ path: string; reason: string }> }> {
	const handle = await open(checkpointPath, constants.O_RDONLY | constants.O_NOFOLLOW);
	let raw: Buffer;
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.nlink !== 1) throw new Error("Checkpoint is not a regular standalone file");
		if (info.size > MAX_CHECKPOINT_BYTES) throw new Error(`Checkpoint exceeds ${MAX_CHECKPOINT_BYTES} bytes`);
		raw = Buffer.alloc(info.size + 1);
		let length = 0;
		while (length < raw.length) {
			const { bytesRead } = await handle.read(raw, length, raw.length - length, length);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > MAX_CHECKPOINT_BYTES) throw new Error(`Checkpoint exceeds ${MAX_CHECKPOINT_BYTES} bytes`);
		raw = raw.subarray(0, length);
	} finally {
		await handle.close();
	}
	const parsed = JSON.parse(raw.toString("utf8")) as Partial<CheckpointFile>;
	const workspace = await realpath(workspaceRoot);
	if (parsed.version !== 1 || parsed.workspace !== workspace || !Array.isArray(parsed.files) || parsed.files.length > MAX_CHECKPOINT_FILES) {
		throw new Error("Invalid checkpoint");
	}
	return { workspace, files: parsed.files as FileSnapshot[], coverageFailures: [...(parsed.coverageFailures ?? []), ...(parsed.commandScope ? [{ path: "<command effects outside snapshot scope>", reason: "Excluded trees and external command effects are not captured" }] : [])] };
}

async function safeTarget(workspace: string, requestedPath: string): Promise<{ root: string; target: string; path: string }> {
	const root = await realpath(workspace);
	const target = resolve(root, requestedPath);
	const path = relative(root, target);
	if (!path || path.startsWith("..") || isAbsolute(path)) throw new Error("Checkpoint path is outside the workspace");
	let ancestor = dirname(target);
	for (;;) {
		try {
			const realAncestor = await realpath(ancestor);
			if (realAncestor !== ancestor) throw new Error("Checkpoint parent path changed through a symlink");
			const rel = relative(root, realAncestor);
			if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Checkpoint path resolves outside the workspace");
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = dirname(ancestor);
			if (parent === ancestor) throw new Error("Checkpoint path has no workspace ancestor");
			ancestor = parent;
		}
	}
	return { root, target, path };
}

const identityOf = (info: Stats): string => `${info.dev}:${info.ino}:${info.ctimeMs}:${info.mtimeMs}`;
const settledBefore = (info: Stats, capturedAt: number): boolean => Math.max(info.mtimeMs, info.ctimeMs) < capturedAt - RACY_WINDOW_MS;

async function readState(workspace: string, path: string, includeContent: boolean, previous?: FileState): Promise<FileState> {
	const safe = await safeTarget(workspace, path);
	return readStateAt(safe.target, path, includeContent, previous);
}

/** Reads a file's state at a target already known to be inside the workspace. `previousCapturedAt` enables the identity shortcut for `previous`. */
async function readStateAt(target: string, path: string, includeContent: boolean, previous?: FileState, previousCapturedAt = Number.POSITIVE_INFINITY): Promise<FileState> {
	let handle;
	try {
		const info = await lstat(target);
		if (!includeContent && info.isFile() && info.nlink === 1 && previous?.identity === identityOf(info) && settledBefore(info, previousCapturedAt)) {
			const { content: _content, ...state } = previous;
			return state;
		}
		if (info.isSymbolicLink()) return { existed: true, kind: "symlink", identity: identityOf(info), link: await readlink(target) };
		handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { existed: false };
		throw error;
	}
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.nlink !== 1) throw new Error(`Checkpoint target is not a regular standalone file: ${path}`);
		if (info.size > MAX_FILE_BYTES) {
			if (includeContent) throw new Error(`Checkpoint target exceeds ${MAX_FILE_BYTES} bytes: ${path}`);
			const digest = createHash("sha256");
			const buffer = Buffer.alloc(64 * 1024);
			let remaining = info.size;
			while (remaining > 0) {
				const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), null);
				if (!bytesRead) break;
				remaining -= bytesRead;
				digest.update(buffer.subarray(0, bytesRead));
			}
			const current = await handle.stat();
			if (remaining || current.size !== info.size || current.ctimeMs !== info.ctimeMs) throw new Error(`Checkpoint target changed during capture: ${path}`);
			return { existed: true, identity: identityOf(info), mode: info.mode & 0o777, sha256: digest.digest("hex") };
		}
		const content = Buffer.alloc(info.size + 1);
		let length = 0;
		while (length < content.length) {
			const { bytesRead } = await handle.read(content, length, content.length - length, length);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > MAX_FILE_BYTES) throw new Error(`Checkpoint target exceeds ${MAX_FILE_BYTES} bytes: ${path}`);
		const exact = content.subarray(0, length);
		return {
			existed: true,
			identity: identityOf(info),
			mode: info.mode & 0o777,
			sha256: hash(exact),
			...(includeContent ? { content: exact.toString("base64") } : {}),
		};
	} finally {
		await handle.close();
	}
}

export async function writeRuntimeFileAtomically(path: string, content: Buffer | string, mode = 0o600): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	let handle;
	try {
		handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
		await handle.writeFile(content);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporary, path);
		await chmod(path, mode);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

interface WorkspaceFile { path: string; target: string }
interface CaptureFailure { path: string; error: unknown }

export interface WorkspaceCaptureStats {
	/** Files and symlinks listed before the command. */
	files: number;
	/** Pre-images read from disk. */
	read: number;
	/** Pre-images reused from an earlier command in the run. */
	reused: number;
}

const byFailurePath = (left: CaptureFailure, right: CaptureFailure): number => left.path < right.path ? -1 : left.path > right.path ? 1 : 0;

async function forEachConcurrent<T>(items: readonly T[], task: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(CAPTURE_CONCURRENCY, items.length) }, async () => {
		while (next < items.length) await task(items[next++]!);
	}));
}

/**
 * Lists workspace files and symlinks without following links. Each directory is entered by its real
 * path, checked once, so the files under it need no per-file ancestor checks.
 */
async function listWorkspaceFiles(workspace: string): Promise<{ files: WorkspaceFile[]; failures: CaptureFailure[] }> {
	const files: WorkspaceFile[] = [];
	const failures: CaptureFailure[] = [];
	const directories = [workspace];
	while (directories.length) {
		const directory = directories.pop()!;
		let entries;
		try {
			if (directory !== workspace && await realpath(directory) !== directory) throw new Error("Checkpoint parent path changed through a symlink");
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			if (directory === workspace) throw error;
			// A directory removed while listing is gone; any other failure leaves its files uncaptured.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures.push({ path: relative(workspace, directory), error });
			continue;
		}
		for (const entry of entries) {
			if (CHECKPOINT_EXCLUDED_NAMES.has(entry.name)) continue;
			const target = join(directory, entry.name);
			if (entry.isDirectory()) directories.push(target);
			else if ((entry.isFile() || entry.isSymbolicLink()) && files.push({ path: relative(workspace, target), target }) > MAX_CHECKPOINT_FILES) {
				throw new Error(`Workspace command checkpoint exceeds ${MAX_CHECKPOINT_FILES} files`);
			}
		}
	}
	return { files, failures };
}

// A pre-command state that failed to capture: nothing is known about the file's content.
const unknownState = (state: FileState): boolean => state.existed && state.sha256 === undefined && state.kind !== "symlink";

export class RunCheckpoint {
	readonly #file: CheckpointFile;
	readonly #path: string;
	readonly #byPath = new Map<string, FileSnapshot>();
	// Unchanged pre-images (with content) from earlier commands in the run, and when each was read.
	#cache = new Map<string, { state: FileState; capturedAt: number }>();
	#workspaceBefore?: { states: Map<string, FileState>; capturedAt: Map<string, number> };
	#workspaceCaptureFailures = 0;
	#workspaceCaptureFinished = false;
	#lastCapture: WorkspaceCaptureStats = { files: 0, read: 0, reused: 0 };

	constructor(workspace: string, runId: string, path: string) {
		this.#file = { version: 1, workspace, runId, createdAt: Date.now(), files: [] };
		this.#path = path;
	}

	get path(): string | undefined {
		return this.#file.commandScope || this.#file.files.length || this.#file.coverageFailures?.length ? this.#path : undefined;
	}

	/** Counts from the latest pre-command capture. */
	get lastWorkspaceCapture(): WorkspaceCaptureStats { return { ...this.#lastCapture }; }

	coverage(): "captured" | "incomplete" { return this.#file.commandScope || this.#file.coverageFailures?.length ? "incomplete" : "captured"; }

	#recordFailure(path: string, error: unknown): void {
		(this.#file.coverageFailures ??= []).push({ path, reason: error instanceof Error ? error.message.slice(0, 300) : "Capture failed" });
	}

	async #captureFailure(path: string, error: unknown): Promise<void> {
		this.#recordFailure(path, error);
		await this.#persist();
	}

	#track(snapshot: FileSnapshot): void {
		this.#file.files.push(snapshot);
		this.#byPath.set(snapshot.path, snapshot);
	}

	async before(path: string): Promise<void> {
		if (this.#byPath.has(path)) return;
		const workspace = await realpath(this.#file.workspace);
		this.#file.workspace = workspace;
		const snapshot = { path, ...(await readState(workspace, path, true)) };
		this.#file.files.push(snapshot);
		this.#byPath.set(path, snapshot);
		await this.#persist();
	}

	async after(path: string): Promise<void> {
		const snapshot = this.#byPath.get(path);
		if (!snapshot) throw new Error(`Checkpoint preimage is missing for ${path}`);
		try { snapshot.after = await readState(this.#file.workspace, path, false); }
		catch (error) { await this.#captureFailure(path, error); }
		await this.#persist();
	}

	workspaceCaptureComplete(): boolean {
		return this.#workspaceCaptureFailures === (this.#file.coverageFailures?.length ?? 0) && this.#workspaceCaptureFinished;
	}

	// Captures every workspace file's state before a command. Pre-images stay in memory: only files the
	// command changes reach the checkpoint file, and unchanged ones are reused by the next command.
	async beforeWorkspace(): Promise<void> {
		if (this.#workspaceBefore) throw new Error("A workspace command checkpoint is already active");
		this.#workspaceCaptureFailures = this.#file.coverageFailures?.length ?? 0;
		this.#workspaceCaptureFinished = false;
		const workspace = await realpath(this.#file.workspace);
		this.#file.workspace = workspace;
		const listing = await listWorkspaceFiles(workspace);
		const now = Date.now();
		const states = new Map<string, FileState>(listing.files.map(({ path }) => [path, { existed: true }]));
		const capturedAt = new Map<string, number>();
		const failures = [...listing.failures];
		const stats: WorkspaceCaptureStats = { files: listing.files.length, read: 0, reused: 0 };
		let contentBytes = 0;
		await forEachConcurrent(listing.files, async ({ path, target }) => {
			try {
				const retained = this.#byPath.get(path);
				if (retained) {
					// The checkpoint already holds this file's run-start pre-image; only its current state is needed.
					states.set(path, await readStateAt(target, path, false, retained.after));
					return;
				}
				const cached = this.#cache.get(path);
				if (cached) {
					const info = await lstat(target);
					if (info.isFile() && info.nlink === 1 && identityOf(info) === cached.state.identity && settledBefore(info, cached.capturedAt)) {
						states.set(path, cached.state);
						capturedAt.set(path, cached.capturedAt);
						contentBytes += cached.state.content?.length ?? 0;
						stats.reused++;
						return;
					}
				}
				const state = await readStateAt(target, path, true);
				states.set(path, state);
				capturedAt.set(path, now);
				contentBytes += state.content?.length ?? 0;
				stats.read++;
			} catch (error) { failures.push({ path, error }); }
		});
		// The pre-images must fit in a checkpoint file if the command changes them.
		if (contentBytes > MAX_CHECKPOINT_BYTES) throw new Error(`Checkpoint exceeds ${MAX_CHECKPOINT_BYTES} bytes`);
		for (const { path, error } of failures.sort(byFailurePath)) this.#recordFailure(path, error);
		this.#lastCapture = stats;
		this.#file.commandScope = true;
		this.#workspaceBefore = { states, capturedAt };
		await this.#persist();
	}

	async afterWorkspace(): Promise<string[]> {
		const before = this.#workspaceBefore;
		if (!before) throw new Error("Workspace command checkpoint was not started");
		const changed: string[] = [];
		const nextCache = new Map<string, { state: FileState; capturedAt: number }>();
		try {
			const workspace = this.#file.workspace;
			const listing = await listWorkspaceFiles(workspace);
			const failures = [...listing.failures];
			const after = new Map<string, FileState>();
			const listed = new Set(listing.files.map(({ path }) => path));
			// A file whose pre-command capture failed stays unknown; reading it again would only repeat the failure.
			const unknown = (path: string): boolean => !this.#byPath.has(path) && unknownState(before.states.get(path) ?? { existed: false });
			await forEachConcurrent(listing.files.filter(({ path }) => !unknown(path)), async ({ path, target }) => {
				try { after.set(path, await readStateAt(target, path, false, before.states.get(path), before.capturedAt.get(path) ?? Date.now())); }
				catch (error) { failures.push({ path, error }); }
			});
			// Files missing from the listing (normally deleted) are read through the checked path.
			await forEachConcurrent([...before.states.keys()].filter((path) => !listed.has(path) && !unknown(path)), async (path) => {
				try { after.set(path, await readState(workspace, path, false)); }
				catch (error) { failures.push({ path, error }); }
			});
			// Pre-existing files first, then new ones, in listing order.
			for (const path of new Set([...before.states.keys(), ...listed])) {
				if (unknown(path)) continue;
				const previous = before.states.get(path);
				const current = after.get(path);
				const retained = this.#byPath.get(path);
				if (retained) {
					if (current) retained.after = current;
				} else if (!current) {
					// No after-state: the coverage failure naming this path makes rewind and preview skip it.
					this.#track({ path, ...(previous ?? { existed: false }) });
				} else if (!sameState(previous ?? { existed: false }, current)) {
					this.#track({ path, ...(previous ?? { existed: false }), after: current });
				} else if (previous?.content !== undefined) {
					nextCache.set(path, { state: previous, capturedAt: before.capturedAt.get(path)! });
				}
				if (current && (!previous || previous.sha256 || previous.kind === "symlink" || previous.existed === false)
					&& !sameContent(previous ?? { existed: false }, current)) changed.push(path);
			}
			for (const { path, error } of failures.sort(byFailurePath)) this.#recordFailure(path, error);
		} catch (error) {
			this.#recordFailure("<workspace>", error);
		}
		this.#cache = nextCache;
		this.#workspaceBefore = undefined;
		await this.#persist();
		this.#workspaceCaptureFinished = true;
		return changed;
	}

	async #persist(): Promise<void> {
		const text = `${JSON.stringify(this.#file, null, 2)}\n`;
		if (Buffer.byteLength(text) > MAX_CHECKPOINT_BYTES) throw new Error(`Checkpoint exceeds ${MAX_CHECKPOINT_BYTES} bytes`);
		await writeRuntimeFileAtomically(this.#path, text);
	}
}

const sameContent = (left: FileState, right: FileState): boolean =>
	left.existed === right.existed && (!left.existed || (left.kind === right.kind && left.link === right.link && left.sha256 === right.sha256 && left.mode === right.mode));
const sameState = (left: FileState, right: FileState): boolean =>
	sameContent(left, right) && (!left.existed || !left.identity || !right.identity || left.identity === right.identity);

// A snapshot with no after-state is a capture gap when a coverage failure names its path: rewind and preview skip it.
const captureGap = (snapshot: FileSnapshot | null, coverageFailures: Array<{ path: string }>): boolean =>
	!!snapshot && typeof snapshot.path === "string" && !snapshot.after && coverageFailures.some(({ path }) => path === snapshot.path);
function assertCheckpointEntry(snapshot: FileSnapshot | null): asserts snapshot is FileSnapshot & { after: NonNullable<FileSnapshot["after"]> } {
	if (!snapshot || typeof snapshot.path !== "string" || typeof snapshot.existed !== "boolean" || !snapshot.after) {
		throw new Error(`Invalid checkpoint file entry${typeof snapshot?.path === "string" ? ` for ${snapshot.path}` : ""}`);
	}
}

export async function rewindCheckpoint(checkpointPath: string, workspaceRoot: string): Promise<RewindResult> {
	const { workspace, files, coverageFailures } = await loadCheckpoint(checkpointPath, workspaceRoot);
	const prepared: Array<{ snapshot: FileSnapshot; target: string; staged?: string; backup: string }> = [];
	for (const snapshot of files) {
		if (captureGap(snapshot, coverageFailures)) continue;
		assertCheckpointEntry(snapshot);
		const safe = await safeTarget(workspace, snapshot.path);
		const current = await readState(workspace, snapshot.path, false);
		if (!sameState(current, snapshot.after)) throw new Error(`Cannot rewind ${snapshot.path}: file changed after Codetonomy's edit`);
		const backup = join(dirname(safe.target), `.${basename(safe.target)}.${randomUUID()}.rewind-backup`);
		let staged: string | undefined;
		if (snapshot.existed && snapshot.kind === "symlink") {
			if (typeof snapshot.link !== "string") throw new Error("Invalid symlink preimage");
			await mkdir(dirname(safe.target), { recursive: true });
			staged = join(dirname(safe.target), `.${basename(safe.target)}.${randomUUID()}.rewind-stage`);
			await symlink(snapshot.link, staged);
		} else if (snapshot.existed) {
			if (typeof snapshot.content !== "string" || typeof snapshot.sha256 !== "string" || typeof snapshot.mode !== "number") {
				throw new Error(`Invalid checkpoint preimage for ${snapshot.path}`);
			}
			const content = Buffer.from(snapshot.content, "base64");
			if (content.length > MAX_FILE_BYTES || hash(content) !== snapshot.sha256) throw new Error(`Checkpoint preimage hash mismatch for ${snapshot.path}`);
			await mkdir(dirname(safe.target), { recursive: true });
			staged = join(dirname(safe.target), `.${basename(safe.target)}.${randomUUID()}.rewind-stage`);
			await writeRuntimeFileAtomically(staged, content, snapshot.mode);
		}
		prepared.push({ snapshot, target: safe.target, ...(staged ? { staged } : {}), backup });
	}

	const published: typeof prepared = [];
	try {
		for (const item of prepared) {
			const current = await readState(workspace, item.snapshot.path, false);
			if (!sameState(current, item.snapshot.after!)) throw new Error(`Cannot rewind ${item.snapshot.path}: file changed during rewind`);
			if (current.existed) await rename(item.target, item.backup);
			published.push(item);
			if (item.staged) await rename(item.staged, item.target);
		}
	} catch (error) {
		for (const item of [...published].reverse()) {
			await unlink(item.target).catch(() => undefined);
			await rename(item.backup, item.target).catch(() => undefined);
		}
		for (const item of prepared) if (item.staged) await unlink(item.staged).catch(() => undefined);
		throw error;
	}
	for (const item of published) await unlink(item.backup).catch(() => undefined);
	return {
		coverage: coverageFailures.length ? "incomplete" : "captured",
		residual: coverageFailures.map(({ path }) => path),
		restored: prepared.map(({ snapshot }) => snapshot).filter(({ existed }) => existed).map(({ path }) => path),
		deleted: prepared.map(({ snapshot }) => snapshot).filter(({ existed }) => !existed).map(({ path }) => path),
	};
}

const textContent = (state: FileState): string => {
	if (!state.existed) return "";
	if (state.kind === "symlink") return `symlink -> ${state.link}`;
	if (typeof state.content !== "string") throw new Error("Checkpoint content is missing");
	return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(state.content, "base64"));
};

export async function previewCheckpoint(checkpointPath: string, workspaceRoot: string): Promise<CheckpointPreview> {
	const { workspace, files, coverageFailures } = await loadCheckpoint(checkpointPath, workspaceRoot);
	const sections: string[] = coverageFailures.map(({ path, reason }) => `Incomplete rewind coverage: ${path}: ${reason}`);
	for (const snapshot of files) {
		if (captureGap(snapshot, coverageFailures)) continue;
		assertCheckpointEntry(snapshot);
		const current = await readState(workspace, snapshot.path, true);
		const status = sameState(current, snapshot.after) ? "" : " (changed since run)";
		let before: string;
		let after: string;
		try {
			before = textContent(snapshot);
			after = textContent(current);
		} catch {
			sections.push(`--- ${snapshot.path}\n+++ ${snapshot.path}${status}\n[Binary content omitted]`);
			continue;
		}
		const removed = before.split("\n").map((line) => `-${line}`).join("\n");
		const added = after.split("\n").map((line) => `+${line}`).join("\n");
		sections.push(`--- a/${snapshot.path}\n+++ b/${snapshot.path}${status}\n@@\n${removed}\n${added}`);
	}
	const raw = sections.join("\n\n") || "No file changes were captured";
	const bytes = Buffer.from(raw);
	const diff = bytes.length <= 64 * 1024
		? raw
		: `${bytes.subarray(0, 64 * 1024).toString("utf8")}\n[Diff truncated]`;
	return { files: files.map(({ path }) => path), diff };
}
