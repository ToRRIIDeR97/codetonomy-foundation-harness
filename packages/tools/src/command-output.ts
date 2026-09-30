import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { redactAuditString, type ConversationOutputRun, type ExecutionResultKind, type WorkspaceMutationRisk } from "@agent-harness/contracts";
import { loadToolOutputManifest, readStoredToolOutput } from "./stored-output.js";

const execFileAsync = (file: string, args: string[]): Promise<string> => new Promise((resolveRun, rejectRun) => {
	execFile(file, args, { windowsHide: true, timeout: 30_000 }, (error, stdout) => error ? rejectRun(error) : resolveRun(stdout));
});
const windowsSystemBinary = (name: string): string => join(process.env.SystemRoot || "C:\\Windows", "System32", name);
let currentUserSid: Promise<string> | undefined;

/**
 * The elevated Windows sandbox runs commands as separate sandbox accounts but does not reliably
 * enforce read denials (#19), and the whole temp directory is a writable sandbox root. An explicit,
 * non-inherited DACL for the current user and SYSTEM keeps sealed output unreadable to them.
 */
export async function restrictToCurrentUser(directory: string): Promise<void> {
	if (process.platform !== "win32") return;
	currentUserSid ??= execFileAsync(windowsSystemBinary("whoami.exe"), ["/user", "/fo", "csv", "/nh"]).then((stdout) => {
		const sid = /"(S-1-[0-9-]+)"\s*$/.exec(stdout.trim())?.[1];
		if (!sid) throw new Error("Cannot determine the current Windows user");
		return sid;
	});
	currentUserSid.catch(() => { currentUserSid = undefined; });
	const sid = await currentUserSid;
	await execFileAsync(windowsSystemBinary("icacls.exe"), [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "/q"]);
}

export const COMMAND_OUTPUT_PREVIEW_BYTES = 16 * 1024;
export const COMMAND_OUTPUT_HEAD_BYTES = 4 * 1024;
export const COMMAND_OUTPUT_TAIL_BYTES = 12 * 1024;
export const COMMAND_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
export const COMMAND_OUTPUT_READABLE_LIMIT_BYTES = COMMAND_OUTPUT_LIMIT_BYTES * 4;
export const RUN_OUTPUT_LIMIT_BYTES = 32 * 1024 * 1024;
export const TOOL_OUTPUT_READ_LIMIT_BYTES = 16 * 1024;
export const TOOL_OUTPUT_MANIFEST = "tool-output-manifest.json";
export const COMMAND_OUTPUT_ROOT = join(realpathSync.native(tmpdir()), ".codetonomy-output");
const TOOL_OUTPUT_MANIFEST_LIMIT_BYTES = 1024 * 1024;

/**
 * Creates the shared command-output root as a private directory. Sandboxed commands deny this path;
 * on Linux, bubblewrap covers a denied path that does not exist yet with an empty read-only
 * placeholder file and can leave it behind, which would block the directory for every later run.
 * So the root is created before any sandbox starts, and such a placeholder (an empty regular file
 * owned by this user) is replaced.
 */
export async function ensureCommandOutputRoot(): Promise<void> {
	const existing = await lstat(COMMAND_OUTPUT_ROOT).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
	if (existing?.isFile() && existing.size === 0 && existing.nlink === 1 && (process.getuid === undefined || existing.uid === process.getuid())) await unlink(COMMAND_OUTPUT_ROOT);
	await mkdir(COMMAND_OUTPUT_ROOT, { recursive: true, mode: 0o700 });
	const root = await lstat(COMMAND_OUTPUT_ROOT);
	if (!root.isDirectory() || root.isSymbolicLink() || await realpath(COMMAND_OUTPUT_ROOT) !== COMMAND_OUTPUT_ROOT) throw new Error("Command output root is not private");
	await chmod(COMMAND_OUTPUT_ROOT, 0o700);
}
const MAX_COMMAND_OUTPUTS = 2_048;
const MAX_ORIGIN_CALL_ID_BYTES = 16 * 1024;
const REDACTION_BOUNDARY_BYTES = 64;
const GENERIC_SECRET_MARKER = /(?:Bearer\s|(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTHORIZATION|COOKIE|CREDENTIAL|PASSWORD|PRIVATE[_-]?KEY|SECRET|TOKEN)\s*[:=]|[?&](?:api[_-]?key|access[_-]?token|key|signature|token)=|https?:\/\/|(?:AKIA|gh[pousr]_|xox[baprs]-|eyJ|(?:sk|key|token)-))/i;

export type CommandResultKind = ExecutionResultKind;
export type CommandMutationRisk = WorkspaceMutationRisk;

export interface CommandOutputReceipt {
	output: string;
	capturedBytes: number;
	readableBytes?: number;
	previewTruncated: boolean;
	omittedBytes: number;
	outputComplete: boolean;
	outputId?: string;
	outputOwner?: string;
	storageFailure?: boolean;
}

export interface ToolOutputManifestEntry {
	outputId: string;
	originCallId: string;
	fileName: string;
	capturedBytes: number;
	readableBytes: number;
	complete: boolean;
	sha256: string;
	identity: string;
	allowedReader: "read_tool_output";
}

export interface ToolOutputManifest {
	version: 1;
	identityKind: "mtime";
	runId: string;
	workspace: string;
	sessionId?: string;
	outputDirectory: string;
	directoryIdentity: string;
	outputs: ToolOutputManifestEntry[];
	partials: Array<{ fileName: string; originCallId: string }>;
}

export const TOOL_OUTPUT_PATTERN_LIMIT = 200;
export const TOOL_OUTPUT_CONTEXT_LINE_LIMIT = 20;

export interface ToolOutputSearch {
	text: string;
	outputId: string;
	originCallId: string;
	pattern: string;
	matches: number;
	truncated: boolean;
	totalBytes: number;
	capturedBytes: number;
	complete: boolean;
}

export interface ToolOutputRange {
	text: string;
	outputId: string;
	originCallId: string;
	offset: number;
	nextOffset?: number;
	totalBytes: number;
	capturedBytes: number;
	complete: boolean;
	eof: boolean;
}

const unavailableOutput = (): Error => new Error("Unknown, expired, or unavailable tool output ID");
const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const identity = (info: { dev: number | bigint; ino: number | bigint; mtimeMs: number; size: number }): string =>
	`${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}`;
const directoryIdentity = (info: { dev: number | bigint; ino: number | bigint }): string => `${info.dev}:${info.ino}`;
const continuation = (byte: number | undefined): boolean => byte !== undefined && (byte & 0xc0) === 0x80;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const redactCapture = (raw: Buffer, knownSecrets: readonly string[], complete: boolean): Buffer => {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const textPrefix = complete ? decoder.decode(raw) : decoder.decode(raw, { stream: true });
	let text = textPrefix;
	const secrets = [...new Set(knownSecrets.filter((candidate) => candidate.length >= 4))];
	if (!complete) for (const secret of secrets) {
		for (let length = secret.length - 1; length > 0; length--) if (text.endsWith(secret.slice(0, length))) {
			text = `${text.slice(0, -length)}[REDACTED]`;
			break;
		}
	}
	text = redactAuditString(text);
	if (!complete) text = text.replace(/(?:Bearer\s+[A-Za-z0-9._~+/-]{0,7}|AKIA[0-9A-Z]{0,15}|gh[pousr]_[A-Za-z0-9_]{0,19}|xox[baprs]-[A-Za-z0-9-]{0,9}|eyJ[A-Za-z0-9_.-]*|(?:sk|key|token)-[A-Za-z0-9_-]{0,11})$/g, "[REDACTED]");
	if (secrets.length) text = text.replace(new RegExp(secrets.sort((left, right) => right.length - left.length).map(escapeRegExp).join("|"), "g"), "[REDACTED]");
	const redacted = Buffer.from(text);
	if (redacted.length > COMMAND_OUTPUT_READABLE_LIMIT_BYTES) throw new Error(`Redacted command output exceeds ${COMMAND_OUTPUT_READABLE_LIMIT_BYTES} bytes`);
	return redacted;
};

const prefixEnd = (bytes: Buffer, maximum: number): number => {
	let end = Math.min(bytes.length, maximum);
	while (end > 0 && continuation(bytes[end])) end--;
	return end;
};

const suffixStart = (bytes: Buffer, maximum: number): number => {
	let start = Math.max(0, bytes.length - maximum);
	while (start < bytes.length && continuation(bytes[start])) start++;
	return start;
};

const clipBytes = (text: string, maximum: number): string => {
	const bytes = Buffer.from(text);
	if (bytes.length <= maximum) return text;
	return `${bytes.subarray(0, prefixEnd(bytes, maximum)).toString("utf8")}\n[... clipped]`;
};

export const TEST_OUTPUT_DIGEST_MIN_BYTES = 4 * 1024;
const TEST_DIGEST_PREAMBLE_BYTES = 1024;
const TEST_DIGEST_BLOCK_BYTES = 3 * 1024;
const TEST_DIGEST_FAILURE_BYTES = 10 * 1024;
const TEST_DIGEST_TRAILER_BYTES = 1024;
const TAP_SUMMARY_LINE = /^# (?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /;
const FAILURE_MARKER_LINE = /(?:^\s*not ok \d|\bFAIL(?:ED)?\b|\bAssertionError\b|\b[A-Za-z]*Error:|\bfailed\b|✖)/;
const FAILURE_MARKER_BYTES = 4 * 1024;
const FAILURE_MARKER_LINES = 40;

/**
 * Condenses node:test TAP output to its counts, failing diagnostics, and any
 * text around the TAP stream. Passing-test detail is left in the saved output,
 * which is where most of a large test log's bytes are.
 */
export function summarizeTestOutput(text: string): string | undefined {
	const lines = text.split(/\r?\n/);
	const tapStart = lines.findIndex((line) => /^TAP version \d+$/.test(line));
	const count = (name: string): number | undefined => {
		const line = lines.find((candidate) => candidate.startsWith(`# ${name} `));
		const value = line ? Number(line.slice(name.length + 3)) : Number.NaN;
		return Number.isSafeInteger(value) ? value : undefined;
	};
	const tests = count("tests");
	const failed = count("fail");
	if (tapStart < 0 || tests === undefined || failed === undefined) return undefined;
	const blocks: string[] = [];
	let failureBytes = 0;
	let omitted = 0;
	for (let index = tapStart; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const match = /^(\s*)not ok \d+/.exec(line);
		if (!match) continue;
		const block = [line];
		if (lines[index + 1] === `${match[1]}  ---`) {
			let end = index + 1;
			while (end < lines.length && lines[end] !== `${match[1]}  ...`) end++;
			block.push(...lines.slice(index + 1, Math.min(end + 1, lines.length)));
			index = end;
		}
		const rendered = clipBytes(block.join("\n"), TEST_DIGEST_BLOCK_BYTES);
		if (failureBytes + Buffer.byteLength(rendered) > TEST_DIGEST_FAILURE_BYTES) { omitted++; continue; }
		blocks.push(rendered);
		failureBytes += Buffer.byteLength(rendered);
	}
	const lastSummary = lines.findLastIndex((line) => TAP_SUMMARY_LINE.test(line));
	const preamble = lines.slice(0, tapStart).join("\n").trim();
	const trailer = lines.slice(lastSummary + 1).join("\n").trim();
	return [
		`[Test output digest: ${tests} tests, ${failed} failed. Passing-test detail is omitted; the full output is saved.]`,
		...(preamble ? [clipBytes(preamble, TEST_DIGEST_PREAMBLE_BYTES)] : []),
		...(blocks.length ? ["Failing entries:", ...blocks] : []),
		...(omitted ? [`[${omitted} more failing entries omitted; search the saved output for "not ok".]`] : []),
		lines.filter((line) => TAP_SUMMARY_LINE.test(line)).join("\n"),
		...(trailer ? [clipBytes(trailer, TEST_DIGEST_TRAILER_BYTES)] : []),
	].join("\n\n");
}

const failureMarkerLines = (text: string): string[] => {
	const found: string[] = [];
	let bytes = 0;
	for (const line of text.split(/\r?\n/)) {
		if (!FAILURE_MARKER_LINE.test(line)) continue;
		const clipped = clipBytes(line, 512);
		if (found.length >= FAILURE_MARKER_LINES || bytes + Buffer.byteLength(clipped) > FAILURE_MARKER_BYTES) break;
		found.push(clipped);
		bytes += Buffer.byteLength(clipped) + 1;
	}
	return found;
};

async function writePrivateAtomically(path: string, content: Buffer): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	let handle: FileHandle | undefined;
	try {
		handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
		await handle.writeFile(content);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporary, path);
		await chmod(path, 0o600);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

export class CommandOutputCaptureError extends Error {
	constructor(message: string, readonly kind: "command-quota" | "run-quota" | "storage") { super(message); }
}

export class CommandOutputStore {
	readonly runId: string;
	readonly workspace: string;
	readonly sessionId?: string;
	readonly #previousOutputs: readonly ConversationOutputRun[];
	readonly outputDirectory: string;
	readonly manifestPath: string;
	readonly indexPath?: string;
	readonly knownSecrets: readonly string[];
	readonly maxCommandBytes: number;
	readonly maxRunBytes: number;
	readonly maxOutputs: number;
	readonly #outputs = new Map<string, ToolOutputManifestEntry>();
	readonly #partials = new Map<string, string>();
	#directoryIdentity = "";
	#directoryCreated = false;
	#capturedBytes = 0;
	#manifestWrite = Promise.resolve();
	#readQueue = Promise.resolve();

	constructor(options: {
		runId?: string;
		workspaceRoot: string;
		sessionId?: string;
		previousOutputs?: readonly ConversationOutputRun[];
		outputDirectory?: string;
		manifestPath?: string;
		indexPath?: string;
		knownSecrets?: readonly string[];
		maxCommandBytes?: number;
		maxRunBytes?: number;
		maxOutputs?: number;
	}) {
		this.runId = options.runId ?? randomUUID();
		this.workspace = resolve(options.workspaceRoot);
		if (options.sessionId !== undefined && (!options.sessionId || options.sessionId.length > 1024)) throw new Error("Invalid output session ID");
		this.sessionId = options.sessionId;
		this.#previousOutputs = structuredClone(options.previousOutputs ?? []);
		const requestedOutputDirectory = resolve(options.outputDirectory ?? join(COMMAND_OUTPUT_ROOT, `.codetonomy-output-${this.runId}-${randomUUID()}`));
		this.outputDirectory = options.outputDirectory
			? join(realpathSync.native(dirname(requestedOutputDirectory)), basename(requestedOutputDirectory))
			: requestedOutputDirectory;
		this.manifestPath = resolve(options.manifestPath ?? join(this.outputDirectory, "manifest.json"));
		this.indexPath = options.indexPath ? resolve(options.indexPath) : undefined;
		this.knownSecrets = options.knownSecrets ?? [];
		this.maxCommandBytes = options.maxCommandBytes ?? COMMAND_OUTPUT_LIMIT_BYTES;
		this.maxRunBytes = options.maxRunBytes ?? RUN_OUTPUT_LIMIT_BYTES;
		this.maxOutputs = options.maxOutputs ?? MAX_COMMAND_OUTPUTS;
		if (!Number.isSafeInteger(this.maxCommandBytes) || this.maxCommandBytes < COMMAND_OUTPUT_PREVIEW_BYTES || this.maxCommandBytes > COMMAND_OUTPUT_LIMIT_BYTES) throw new Error(`Command output quota must be ${COMMAND_OUTPUT_PREVIEW_BYTES}-${COMMAND_OUTPUT_LIMIT_BYTES} bytes`);
		if (!Number.isSafeInteger(this.maxRunBytes) || this.maxRunBytes < this.maxCommandBytes || this.maxRunBytes > RUN_OUTPUT_LIMIT_BYTES) throw new Error(`Run output quota must be ${this.maxCommandBytes}-${RUN_OUTPUT_LIMIT_BYTES} bytes`);
		if (!Number.isSafeInteger(this.maxOutputs) || this.maxOutputs < 1 || this.maxOutputs > MAX_COMMAND_OUTPUTS) throw new Error(`Run output count must be 1-${MAX_COMMAND_OUTPUTS}`);
	}

	privatePaths(): string[] {
		return [COMMAND_OUTPUT_ROOT, this.outputDirectory, this.manifestPath, ...this.#previousOutputs.map(run => dirname(run.tracePath)), ...(this.indexPath ? [dirname(this.indexPath), this.indexPath] : [])];
	}

	async prepare(): Promise<void> {
		await this.#ensureDirectory();
		await this.#writeManifest();
	}

	async publishIndex(): Promise<void> {
		if (!this.indexPath || (!this.#outputs.size && !this.#partials.size)) return;
		await this.#writeManifest();
		const manifest = await this.#readManifest();
		await writePrivateAtomically(this.indexPath, Buffer.from(`${JSON.stringify({ version: 1, runId: this.runId, manifestPath: this.manifestPath, manifestBytes: manifest.length, manifestSha256: hash(manifest) })}\n`));
	}

	/** Call after publishing; the private session pins the exact manifest, not an arbitrary output directory. */
	sessionReference(): ConversationOutputRun | undefined {
		if (!this.sessionId || !this.indexPath || !this.#outputs.size) return undefined;
		const tracePath = join(dirname(this.indexPath), "trace.jsonl");
		const manifest = loadToolOutputManifest(tracePath, this.runId);
		if (!manifest || manifest.sessionId !== this.sessionId || manifest.workspace !== this.workspace) throw new Error("Output session ownership changed");
		return { runId: this.runId, tracePath, manifestSha256: manifest.manifestSha256, outputIds: [...this.#outputs.keys()] };
	}

	createCapture(originCallId: string): CommandOutputCapture {
		if (!originCallId || Buffer.byteLength(originCallId) > MAX_ORIGIN_CALL_ID_BYTES) throw new Error(`Command output call ID must be 1-${MAX_ORIGIN_CALL_ID_BYTES} bytes`);
		return new CommandOutputCapture(this, createHash("sha256").update(originCallId).digest("hex"));
	}

	outputReferences(): Array<{ outputId: string; outputOwner: string }> {
		return [...this.#outputs.values()].map(({ outputId, originCallId: outputOwner }) => ({ outputId, outputOwner }));
	}

	claim(requested: number, commandBytes: number): { accepted: number; limit?: "command-quota" | "run-quota" } {
		const commandRemaining = Math.max(0, this.maxCommandBytes - commandBytes);
		const runRemaining = Math.max(0, this.maxRunBytes - this.#capturedBytes);
		const accepted = Math.min(requested, commandRemaining, runRemaining);
		this.#capturedBytes += accepted;
		if (accepted === requested) return { accepted };
		return { accepted, limit: commandRemaining <= runRemaining ? "command-quota" : "run-quota" };
	}

	async beginPartial(fileName: string, originCallId: string): Promise<string> {
		await this.#ensureDirectory();
		if (basename(fileName) !== fileName || this.#partials.has(fileName) || !/^[0-9a-f]{64}$/.test(originCallId)) throw new Error("Invalid output partial ownership");
		if (this.#outputs.size + this.#partials.size >= this.maxOutputs) throw new Error(`Run output count exceeds ${this.maxOutputs}`);
		const path = join(this.outputDirectory, fileName);
		this.#partials.set(fileName, originCallId);
		try { await this.#writeManifest(); }
		catch (error) {
			this.#partials.delete(fileName);
			throw error;
		}
		return path;
	}

	async discardPartial(fileName: string): Promise<void> {
		if (!this.#partials.has(fileName)) return;
		try { await unlink(join(this.outputDirectory, fileName)); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		this.#partials.delete(fileName);
		await this.#writeManifest();
	}

	async sealBytes(originCallId: string, raw: Buffer, capturedBytes: number, complete: boolean): Promise<{ entry: ToolOutputManifestEntry; bytes: Buffer }> {
		const fileName = `${randomUUID()}.partial`;
		const path = await this.beginPartial(fileName, originCallId);
		let handle: FileHandle | undefined;
		try {
			handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
			await handle.writeFile(raw);
			await handle.sync();
			await handle.close();
			handle = undefined;
			return await this.sealPartial(fileName, originCallId, capturedBytes, complete);
		} catch (error) {
			await handle?.close().catch(() => undefined);
			await this.discardPartial(fileName);
			throw error;
		}
	}

	async sealPartial(fileName: string, originCallId: string, capturedBytes: number, complete: boolean): Promise<{ entry: ToolOutputManifestEntry; bytes: Buffer }> {
		if (this.#partials.get(fileName) !== originCallId) throw new Error("Output partial ownership changed");
		const partialPath = join(this.outputDirectory, fileName);
		const handle = await open(partialPath, constants.O_RDONLY | constants.O_NOFOLLOW);
		let raw: Buffer;
		try {
			const info = await handle.stat();
			if (!info.isFile() || info.nlink !== 1 || info.size !== capturedBytes || info.size > this.maxCommandBytes) throw new Error("Output partial identity or size changed");
			raw = Buffer.alloc(info.size);
			let length = 0;
			while (length < raw.length) {
				const { bytesRead } = await handle.read(raw, length, raw.length - length, length);
				if (!bytesRead) break;
				length += bytesRead;
			}
			if (length !== raw.length) throw new Error("Output partial changed while sealing");
		} finally { await handle.close(); }

		const bytes = redactCapture(raw, this.knownSecrets, complete);
		const outputId = randomUUID();
		const outputFile = `${outputId}.output`;
		const outputPath = join(this.outputDirectory, outputFile);
		let outputHandle: FileHandle | undefined;
		try {
			outputHandle = await open(outputPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
			await outputHandle.writeFile(bytes);
			await outputHandle.sync();
			await outputHandle.close();
			outputHandle = undefined;
			await chmod(outputPath, 0o400);
			const info = await lstat(outputPath);
			if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Sealed output is not a standalone file");
			const entry: ToolOutputManifestEntry = {
				outputId,
				originCallId,
				fileName: outputFile,
				capturedBytes,
				readableBytes: bytes.length,
				complete,
				sha256: hash(bytes),
				identity: identity(info),
				allowedReader: "read_tool_output",
			};
			await unlink(partialPath);
			this.#partials.delete(fileName);
			this.#outputs.set(outputId, entry);
			try { await this.#writeManifest(); }
			catch (error) {
				this.#outputs.delete(outputId);
				await unlink(outputPath).catch(() => undefined);
				throw error;
			}
			return { entry, bytes };
		} catch (error) {
			await outputHandle?.close().catch(() => undefined);
			await unlink(outputPath).catch(() => undefined);
			throw error;
		}
	}

	read(outputId: string, offset: number, limit: number, signal?: AbortSignal): Promise<ToolOutputRange> {
		const read = this.#readQueue.then(() => this.#read(outputId, offset, limit, signal));
		this.#readQueue = read.then(() => undefined, () => undefined);
		return read;
	}

	/** Returns lines containing `pattern` (case-insensitive literal) with surrounding context, bounded like a range read. */
	search(outputId: string, pattern: string, contextLines: number, signal?: AbortSignal): Promise<ToolOutputSearch> {
		const search = this.#readQueue.then(() => this.#search(outputId, pattern, contextLines, signal));
		this.#readQueue = search.then(() => undefined, () => undefined);
		return search;
	}

	async #search(outputId: string, pattern: string, contextLines: number, signal?: AbortSignal): Promise<ToolOutputSearch> {
		if (!pattern || pattern.length > TOOL_OUTPUT_PATTERN_LIMIT || /[\r\n]/.test(pattern)) throw new Error(`Tool output pattern must be 1-${TOOL_OUTPUT_PATTERN_LIMIT} characters on one line`);
		if (!Number.isSafeInteger(contextLines) || contextLines < 0 || contextLines > TOOL_OUTPUT_CONTEXT_LINE_LIMIT) throw new Error(`Tool output context must be 0-${TOOL_OUTPUT_CONTEXT_LINE_LIMIT} lines`);
		const loaded = await this.#load(outputId, signal);
		const lines = new TextDecoder("utf-8", { fatal: true }).decode(loaded.bytes).split(/\r?\n/);
		const needle = pattern.toLowerCase();
		const matches = new Set(lines.flatMap((line, index) => line.toLowerCase().includes(needle) ? [index] : []));
		const shown = new Set<number>();
		for (const index of matches) for (let line = Math.max(0, index - contextLines); line <= Math.min(lines.length - 1, index + contextLines); line++) shown.add(line);
		const rendered: string[] = [];
		let bytes = 0;
		let previous = -2;
		let truncated = false;
		for (const index of [...shown].sort((left, right) => left - right)) {
			const line = `${index + 1}${matches.has(index) ? ":" : "-"} ${lines[index]}`;
			const entry = previous >= 0 && index !== previous + 1 ? `--\n${line}` : line;
			if (bytes + Buffer.byteLength(entry) + 1 > TOOL_OUTPUT_READ_LIMIT_BYTES) { truncated = true; break; }
			rendered.push(entry);
			bytes += Buffer.byteLength(entry) + 1;
			previous = index;
		}
		return { text: rendered.join("\n"), outputId, originCallId: loaded.originCallId, pattern, matches: matches.size, truncated, totalBytes: loaded.bytes.length, capturedBytes: loaded.capturedBytes, complete: loaded.complete };
	}

	async #read(outputId: string, offset: number, limit: number, signal?: AbortSignal): Promise<ToolOutputRange> {
		if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Tool output offset must be a nonnegative byte offset");
		if (!Number.isSafeInteger(limit) || limit < 4 || limit > TOOL_OUTPUT_READ_LIMIT_BYTES) throw new Error(`Tool output limit must be 4-${TOOL_OUTPUT_READ_LIMIT_BYTES} bytes`);
		const loaded = await this.#load(outputId, signal, offset);
		if (offset > loaded.bytes.length) throw new Error(`Tool output offset ${offset} is beyond ${loaded.bytes.length} bytes`);
		const bytes = loaded.bytes.subarray(offset, Math.min(loaded.bytes.length, offset + limit + 1));
		if (continuation(bytes[0])) throw loaded.previous ? unavailableOutput() : new Error("Tool output offset must be a UTF-8 character boundary");
		let length = Math.min(bytes.length, limit);
		while (length > 0 && continuation(bytes[length])) length--;
		if (!length && offset < loaded.bytes.length) throw new Error("Tool output limit is too small for the next UTF-8 character");
		const end = offset + length;
		const nextOffset = end < loaded.bytes.length ? end : undefined;
		return {
			text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)),
			outputId,
			originCallId: loaded.originCallId,
			offset,
			...(nextOffset === undefined ? {} : { nextOffset }),
			totalBytes: loaded.bytes.length,
			capturedBytes: loaded.capturedBytes,
			complete: loaded.complete,
			eof: nextOffset === undefined,
		};
	}

	async #load(outputId: string, signal?: AbortSignal, previousOffset = 0): Promise<{ bytes: Buffer; originCallId: string; capturedBytes: number; complete: boolean; previous: boolean }> {
		const entry = this.#outputs.get(outputId);
		if (!entry) {
			signal?.throwIfAborted();
			try {
				const run = this.#previousOutputs.find(run => run.outputIds.includes(outputId));
				if (!this.sessionId || !run) throw unavailableOutput();
				const manifest = loadToolOutputManifest(run.tracePath, run.runId);
				if (!manifest || manifest.manifestSha256 !== run.manifestSha256 || manifest.sessionId !== this.sessionId
					|| realpathSync.native(manifest.workspace) !== realpathSync.native(this.workspace)) throw unavailableOutput();
				const previous = manifest.outputs.find(output => output.outputId === outputId);
				if (!previous) throw unavailableOutput();
				const bytes = readStoredToolOutput(manifest, previous);
				if (previousOffset > bytes.length) throw unavailableOutput();
				return { bytes, originCallId: previous.originCallId, capturedBytes: previous.capturedBytes, complete: previous.complete, previous: true };
			} catch { throw unavailableOutput(); }
		}
		if (entry.allowedReader !== "read_tool_output") throw unavailableOutput();
		let handle: FileHandle | undefined;
		try {
			signal?.throwIfAborted();
			await this.#verifyDirectory();
			handle = await open(join(this.outputDirectory, entry.fileName), constants.O_RDONLY | constants.O_NOFOLLOW);
			const file = handle;
			const info = await file.stat();
			if (!info.isFile() || info.nlink !== 1 || identity(info) !== entry.identity || info.size !== entry.readableBytes) throw unavailableOutput();
			// Re-verify the bounded full digest on every read. Caching a verified
			// digest would let a same-size rewrite that lands after the read/hash
			// but before the concluding stat bind that digest to changed metadata,
			// so no post-hash metadata is ever treated as already hashed.
			const complete = Buffer.alloc(info.size);
			let length = 0;
			while (length < complete.length) {
				signal?.throwIfAborted();
				const { bytesRead } = await file.read(complete, length, complete.length - length, length);
				if (!bytesRead) break;
				length += bytesRead;
			}
			const after = await file.stat();
			if (length !== complete.length || hash(complete) !== entry.sha256
				|| !after.isFile() || after.nlink !== 1 || identity(after) !== entry.identity) throw unavailableOutput();
			return { bytes: complete, originCallId: entry.originCallId, capturedBytes: entry.capturedBytes, complete: entry.complete, previous: false };
		} catch (error) {
			if (signal?.aborted) throw error;
			throw unavailableOutput();
		}
		finally { await handle?.close(); }
	}

	async discardUnissued(issuedOutputIds: ReadonlySet<string>): Promise<void> {
		await this.#manifestWrite.catch(() => undefined);
		const unissued = [...this.#outputs].filter(([outputId]) => !issuedOutputIds.has(outputId));
		if (!unissued.length) return;
		await this.#verifyDirectory();
		for (const [outputId, entry] of unissued) {
			await this.read(outputId, 0, 4);
			await unlink(join(this.outputDirectory, entry.fileName));
			this.#outputs.delete(outputId);
		}
		await this.#writeManifest();
	}

	async cleanupIfEmpty(): Promise<void> {
		await this.#manifestWrite.catch(() => undefined);
		if (this.#outputs.size || this.#partials.size) return;
		await unlink(this.manifestPath).catch(() => undefined);
		if (this.indexPath) await unlink(this.indexPath).catch(() => undefined);
		if (this.#directoryCreated) await rmdir(this.outputDirectory).catch(() => undefined);
	}

	async discard(): Promise<void> {
		await this.#manifestWrite.catch(() => undefined);
		if (!this.#directoryCreated) {
			if (this.indexPath) await unlink(this.indexPath).catch(() => undefined);
			return;
		}
		await this.#verifyDirectory();
		for (const [outputId, entry] of this.#outputs) {
			await this.read(outputId, 0, 4);
			await unlink(join(this.outputDirectory, entry.fileName));
			this.#outputs.delete(outputId);
		}
		for (const fileName of this.#partials.keys()) {
			const info = await lstat(join(this.outputDirectory, fileName));
			if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Invalid output partial");
			await unlink(join(this.outputDirectory, fileName));
			this.#partials.delete(fileName);
		}
		await unlink(this.manifestPath).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
		if (this.indexPath) await unlink(this.indexPath).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
		await rmdir(this.outputDirectory);
	}

	async #ensureDirectory(): Promise<void> {
		if (this.#directoryCreated) return this.#verifyDirectory();
		const parent = dirname(this.outputDirectory);
		if (parent === COMMAND_OUTPUT_ROOT) await ensureCommandOutputRoot();
		else await realpath(parent);
		await mkdir(this.outputDirectory, { mode: 0o700 });
		const info = await lstat(this.outputDirectory);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Command output directory is not private");
		await chmod(this.outputDirectory, 0o700);
		try { await restrictToCurrentUser(this.outputDirectory); }
		catch (error) {
			await rmdir(this.outputDirectory).catch(() => undefined);
			throw new Error("Command output directory is not private", { cause: error });
		}
		this.#directoryIdentity = directoryIdentity(info);
		this.#directoryCreated = true;
	}

	async #verifyDirectory(): Promise<void> {
		if (!this.#directoryCreated) throw new Error("Command output directory is unavailable");
		const info = await lstat(this.outputDirectory);
		const actualPath = await realpath(this.outputDirectory);
		if (!info.isDirectory() || info.isSymbolicLink() || directoryIdentity(info) !== this.#directoryIdentity || actualPath !== this.outputDirectory) {
			throw new Error("Command output directory identity changed");
		}
	}

	async #readManifest(): Promise<Buffer> {
		await this.#verifyDirectory();
		const handle = await open(this.manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const before = await handle.stat();
			if (!before.isFile() || before.nlink !== 1 || before.size > TOOL_OUTPUT_MANIFEST_LIMIT_BYTES) throw new Error("Invalid command output manifest");
			const bytes = Buffer.alloc(before.size);
			let length = 0;
			while (length < bytes.length) {
				const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
				if (!bytesRead) break;
				length += bytesRead;
			}
			const after = await handle.stat();
			if (identity(before) !== identity(after) || length !== before.size) throw new Error("Command output manifest changed while publishing");
			return bytes;
		} finally { await handle.close(); }
	}

	async #writeManifest(): Promise<void> {
		if (!this.#directoryCreated) return;
		const write = async () => {
			await this.#verifyDirectory();
			const manifest: ToolOutputManifest = {
				version: 1,
				identityKind: "mtime",
				runId: this.runId,
				workspace: this.workspace,
				...(this.sessionId ? { sessionId: this.sessionId } : {}),
				outputDirectory: this.outputDirectory,
				directoryIdentity: this.#directoryIdentity,
				outputs: [...this.#outputs.values()],
				partials: [...this.#partials].map(([fileName, originCallId]) => ({ fileName, originCallId })),
			};
			const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
			if (bytes.length > TOOL_OUTPUT_MANIFEST_LIMIT_BYTES) throw new Error("Command output manifest exceeds 1 MiB");
			await writePrivateAtomically(this.manifestPath, bytes);
		};
		this.#manifestWrite = this.#manifestWrite.then(write, write);
		await this.#manifestWrite;
	}
}

export class CommandOutputCapture {
	readonly #store: CommandOutputStore;
	readonly #originCallId: string;
	readonly #memory: Buffer[] = [];
	readonly #evidenceHead: Buffer[] = [];
	#evidenceHeadBytes = 0;
	#evidenceTail = Buffer.alloc(0);
	#redactionScanTail = Buffer.alloc(0);
	#genericLineSensitive = false;
	#partialName?: string;
	#partialPath?: string;
	#handle?: FileHandle;
	#capturedBytes = 0;
	#finished = false;
	#storageFailure = false;

	constructor(store: CommandOutputStore, originCallId: string) {
		this.#store = store;
		this.#originCallId = originCallId;
	}

	async append(chunk: Buffer): Promise<void> {
		if (this.#finished) throw new Error("Cannot append to a finished command output capture");
		if (!chunk.length) return;
		const { accepted, limit } = this.#store.claim(chunk.length, this.#capturedBytes);
		if (accepted) await this.#appendAccepted(chunk.subarray(0, accepted));
		if (limit) throw new CommandOutputCaptureError(
			limit === "command-quota"
				? `Command output exceeds ${this.#store.maxCommandBytes} captured bytes`
				: `Run output exceeds ${this.#store.maxRunBytes} captured bytes`,
			limit,
		);
	}

	async finish(complete: boolean): Promise<CommandOutputReceipt> {
		if (this.#finished) throw new Error("Command output capture already finished");
		this.#finished = true;
		try { await this.#handle?.close(); }
		catch { this.#storageFailure = true; }
		this.#handle = undefined;

		if (this.#partialName && !this.#storageFailure) {
			try {
				const sealed = await this.#store.sealPartial(this.#partialName, this.#originCallId, this.#capturedBytes, complete);
				return this.#receipt(sealed.bytes, sealed.entry.outputId, complete);
			} catch {
				this.#storageFailure = true;
			}
		}
		if (this.#partialName) await this.#store.discardPartial(this.#partialName).catch(() => undefined);
		if (this.#storageFailure) return this.#storageFailureReceipt();
		const raw = Buffer.concat(this.#memory);
		if (!raw.length) return this.#receipt(raw, undefined, complete);
		try {
			const sealed = await this.#store.sealBytes(this.#originCallId, raw, this.#capturedBytes, complete);
			return this.#receipt(sealed.bytes, sealed.entry.outputId, complete);
		} catch { return this.#storageFailureReceipt(); }
	}

	async #appendAccepted(chunk: Buffer): Promise<void> {
		const previousBytes = this.#capturedBytes;
		this.#capturedBytes += chunk.length;
		const headBytes = Math.min(chunk.length, COMMAND_OUTPUT_HEAD_BYTES + REDACTION_BOUNDARY_BYTES - this.#evidenceHeadBytes);
		if (headBytes > 0) {
			this.#evidenceHead.push(Buffer.from(chunk.subarray(0, headBytes)));
			this.#evidenceHeadBytes += headBytes;
		}
		this.#evidenceTail = chunk.length >= COMMAND_OUTPUT_TAIL_BYTES + REDACTION_BOUNDARY_BYTES
			? Buffer.from(chunk.subarray(chunk.length - COMMAND_OUTPUT_TAIL_BYTES - REDACTION_BOUNDARY_BYTES))
			: Buffer.concat([this.#evidenceTail, chunk]).subarray(-COMMAND_OUTPUT_TAIL_BYTES - REDACTION_BOUNDARY_BYTES);
		const lastNewline = chunk.lastIndexOf(0x0a);
		const scan = lastNewline >= 0 ? chunk.subarray(lastNewline + 1) : Buffer.concat([this.#redactionScanTail, chunk]);
		this.#genericLineSensitive = (lastNewline < 0 && this.#genericLineSensitive) || GENERIC_SECRET_MARKER.test(scan.toString("latin1"));
		this.#redactionScanTail = Buffer.from(scan.subarray(-64));
		try {
			if (!this.#handle && this.#capturedBytes > COMMAND_OUTPUT_PREVIEW_BYTES) {
				this.#partialName = `${randomUUID()}.partial`;
				this.#partialPath = await this.#store.beginPartial(this.#partialName, this.#originCallId);
				this.#handle = await open(this.#partialPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
				for (const buffered of this.#memory) await this.#handle.writeFile(buffered);
				this.#memory.length = 0;
			}
			if (this.#handle) await this.#handle.writeFile(chunk);
			else this.#memory.push(chunk);
		} catch (error) {
			this.#capturedBytes = previousBytes + chunk.length;
			this.#storageFailure = true;
			await this.#handle?.close().catch(() => undefined);
			this.#handle = undefined;
			if (this.#partialName) await this.#store.discardPartial(this.#partialName).catch(() => undefined);
			throw new CommandOutputCaptureError("Private command output storage failed", "storage");
		}
	}

	#storageFailureReceipt(): CommandOutputReceipt {
		const notice = `[Capture stopped: private storage failed after ${this.#capturedBytes} bytes]`;
		const head = Buffer.concat(this.#evidenceHead);
		const overlap = Math.max(0, head.length + this.#evidenceTail.length - this.#capturedBytes);
		const tail = this.#evidenceTail.subarray(overlap);
		let omittedBytes = Math.max(0, this.#capturedBytes - head.length - tail.length);
		let output: string;
		try {
			if (!omittedBytes) {
				const redacted = redactCapture(Buffer.concat([head, tail]), this.#store.knownSecrets, false);
				const headEnd = prefixEnd(redacted, COMMAND_OUTPUT_HEAD_BYTES);
				const tailStart = Math.max(headEnd, suffixStart(redacted, COMMAND_OUTPUT_TAIL_BYTES));
				omittedBytes = tailStart - headEnd;
				const preview = omittedBytes
					? `${redacted.subarray(0, headEnd).toString("utf8")}\n\n[Output preview omitted ${omittedBytes} bytes]\n\n${redacted.subarray(tailStart).toString("utf8")}`
					: redacted.toString("utf8");
				output = `${preview}\n\n${notice}`;
			} else {
				const newline = tail.indexOf(0x0a);
				let contextEnd = tail[0] === 0x0a ? 1 : newline >= 0 ? newline + 1 : this.#genericLineSensitive ? tail.length : Math.min(1, tail.length);
				while (contextEnd < tail.length && continuation(tail[contextEnd])) contextEnd++;
				const safeTail = tail.subarray(contextEnd);
				const boundaryLineStart = head.lastIndexOf(0x0a, COMMAND_OUTPUT_HEAD_BYTES - 1) + 1;
				const safeHead = GENERIC_SECRET_MARKER.test(head.subarray(boundaryLineStart).toString("latin1")) ? head.subarray(0, boundaryLineStart) : head;
				const redactedHead = redactCapture(safeHead, this.#store.knownSecrets, false).toString("utf8");
				const redactedTail = redactCapture(safeTail, this.#store.knownSecrets, false);
				const secretGuard = Math.max(0, ...this.#store.knownSecrets.filter((secret) => secret.length >= 4).map((secret) => Buffer.byteLength(secret) - 1));
				let guardedTailStart = Math.min(redactedTail.length, secretGuard);
				while (guardedTailStart < redactedTail.length && continuation(redactedTail[guardedTailStart])) guardedTailStart++;
				const guardedTail = redactedTail.subarray(guardedTailStart);
				const boundedHead = Buffer.from(redactedHead).subarray(0, prefixEnd(Buffer.from(redactedHead), COMMAND_OUTPUT_HEAD_BYTES));
				const tailStart = suffixStart(guardedTail, COMMAND_OUTPUT_TAIL_BYTES);
				omittedBytes += contextEnd + head.length - safeHead.length + Buffer.byteLength(redactedHead) - boundedHead.length + guardedTailStart + tailStart;
				output = `${boundedHead.toString("utf8")}\n\n[Output preview omitted ${omittedBytes} bytes]\n\n${guardedTail.subarray(tailStart).toString("utf8")}\n\n${notice}`;
			}
		} catch {
			omittedBytes = this.#capturedBytes;
			output = `[Capture stopped: command output is not valid UTF-8; ${this.#capturedBytes} bytes were not exposed]`;
		}
		return {
			output,
			capturedBytes: this.#capturedBytes,
			previewTruncated: omittedBytes > 0,
			omittedBytes,
			outputComplete: false,
			storageFailure: true,
		};
	}

	#receipt(bytes: Buffer, outputId: string | undefined, complete: boolean): CommandOutputReceipt {
		const digest = outputId && bytes.length > TEST_OUTPUT_DIGEST_MIN_BYTES ? summarizeTestOutput(bytes.toString("utf8")) : undefined;
		if (digest && Buffer.byteLength(digest) < bytes.length) {
			const output = `${digest}\n\n[Full output: read_tool_output({"outputId":"${outputId}","offset":0,"limit":${TOOL_OUTPUT_READ_LIMIT_BYTES}}), or pass "pattern" (for example "not ok") to search it.]`;
			return {
				output,
				capturedBytes: this.#capturedBytes,
				readableBytes: bytes.length,
				previewTruncated: true,
				omittedBytes: Math.max(0, bytes.length - Buffer.byteLength(digest)),
				outputComplete: complete,
				outputId,
				outputOwner: this.#originCallId,
			};
		}
		if (bytes.length <= COMMAND_OUTPUT_PREVIEW_BYTES) return {
			output: bytes.toString("utf8"),
			capturedBytes: this.#capturedBytes,
			readableBytes: bytes.length,
			previewTruncated: false,
			omittedBytes: 0,
			outputComplete: complete,
			...(outputId ? { outputId, outputOwner: this.#originCallId } : {}),
		};
		if (!outputId) throw new Error("Truncated command output is missing its sealed reference");
		const headEnd = prefixEnd(bytes, COMMAND_OUTPUT_HEAD_BYTES);
		const hasMarkers = failureMarkerLines(bytes.subarray(headEnd, suffixStart(bytes, COMMAND_OUTPUT_TAIL_BYTES)).toString("utf8")).length > 0;
		const tailStart = suffixStart(bytes, hasMarkers ? COMMAND_OUTPUT_TAIL_BYTES - FAILURE_MARKER_BYTES : COMMAND_OUTPUT_TAIL_BYTES);
		const markers = hasMarkers ? failureMarkerLines(bytes.subarray(headEnd, tailStart).toString("utf8")) : [];
		const omittedBytes = Math.max(0, tailStart - headEnd);
		const markerSection = markers.length ? `[Failure-marker lines from the omitted range:]\n${markers.join("\n")}\n\n` : "";
		const notice = `\n\n[Output preview omitted ${omittedBytes} bytes. Continue with read_tool_output({"outputId":"${outputId}","offset":${headEnd},"limit":${TOOL_OUTPUT_READ_LIMIT_BYTES}}), or pass "pattern" to search it.]\n\n${markerSection}`;
		return {
			output: `${bytes.subarray(0, headEnd).toString("utf8")}${notice}${bytes.subarray(tailStart).toString("utf8")}`,
			capturedBytes: this.#capturedBytes,
			readableBytes: bytes.length,
			previewTruncated: true,
			omittedBytes,
			outputComplete: complete,
			outputId,
			outputOwner: this.#originCallId,
		};
	}
}
