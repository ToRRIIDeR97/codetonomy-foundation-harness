import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { accessSync, constants, existsSync, readdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rename, unlink } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, matchesGlob, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { isSensitiveWorkspacePath, redactAuditString } from "@agent-harness/contracts";
import { bashInstallationRoot as bashInstallationRootOf, BashCommandPlanner, bashPermissionTarget, bashPermissionTargets, bashPlanUsesReadOnlySandbox, bashPlanUsesTrustedExecution, planBashCommand, resolveBashExecutable, sandboxPlatformDefaultsOverlap, type BashCommandPlan, type BashLeafOperation, type BashOperation, type BashToolArguments } from "./bash-driver.js";
import { COMMAND_OUTPUT_ROOT, CommandOutputCaptureError, ensureCommandOutputRoot, CommandOutputStore, TOOL_OUTPUT_CONTEXT_LINE_LIMIT, TOOL_OUTPUT_PATTERN_LIMIT, TOOL_OUTPUT_READ_LIMIT_BYTES, type CommandMutationRisk, type CommandResultKind } from "./command-output.js";
export * from "./stored-output.js";
export * from "./modules.js";
export * from "./write-claim.js";
import { createModuleTool, type HarnessModuleRunContext, type HarnessModuleTool } from "./modules.js";

export { BashCommandPlanner, bashOperationHasPreciseCommand, bashPermissionTarget, bashPermissionTargets, bashPlanUsesReadOnlySandbox, bashPlanUsesTrustedExecution, parseBashCommand, planBashCommand, resolveBashExecutable, type BashCommandPlan, type BashLeafOperation, type BashOperation, type BashPlanReason, type BashPlanRoute, type BashToolArguments } from "./bash-driver.js";
export { COMMAND_OUTPUT_ROOT, CommandOutputStore, ensureCommandOutputRoot, restrictToCurrentUser, COMMAND_OUTPUT_HEAD_BYTES, COMMAND_OUTPUT_LIMIT_BYTES, COMMAND_OUTPUT_PREVIEW_BYTES, COMMAND_OUTPUT_READABLE_LIMIT_BYTES, COMMAND_OUTPUT_TAIL_BYTES, RUN_OUTPUT_LIMIT_BYTES, summarizeTestOutput, TEST_OUTPUT_DIGEST_MIN_BYTES, TOOL_OUTPUT_CONTEXT_LINE_LIMIT, TOOL_OUTPUT_MANIFEST, TOOL_OUTPUT_PATTERN_LIMIT, TOOL_OUTPUT_READ_LIMIT_BYTES, type CommandMutationRisk, type CommandOutputReceipt, type CommandResultKind, type ToolOutputManifest, type ToolOutputManifestEntry, type ToolOutputRange, type ToolOutputSearch } from "./command-output.js";

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_SEARCHED_FILES = 20_000;
const MAX_WORKSPACE_SCAN_ENTRIES = 100_000;
const displayPath = (path: string): string => path.replaceAll("\\", "/");
const IGNORED_DIRECTORIES = new Set([".codetonomy", ".git", ".harness", ".pnpm-store", ".reference-repos", "dist", "node_modules"]);
const PROTECTED_READ_DIRECTORIES = new Set([".agents", ".codex", ".codetonomy", ".git", ".harness", ".pnpm-store", "node_modules"]);
const assertWritablePath = (path: string): void => {
	if (path.split(/[\\/]/).some((part) => PROTECTED_READ_DIRECTORIES.has(part.toLowerCase()))) throw new Error("Path is protected from workspace writes");
	if (isSensitiveWorkspacePath(path)) throw new Error("Sensitive workspace paths are protected from agent tools");
};

export const READ_ONLY_TOOL_IDS = ["list_workspace", "search_workspace", "inspect_workspace", "read_tool_output"] as const;
export const CODING_TOOL_IDS = [...READ_ONLY_TOOL_IDS, "write_workspace", "edit_workspace", "run_workspace_command"] as const;
export const BASH_FACADE_TARGET_IDS = ["list_workspace", "search_workspace", "inspect_workspace", "run_workspace_command"] as const;
const BASH_FACADE_TARGETS = new Set<string>(BASH_FACADE_TARGET_IDS);
export const bashFacadeProvides = (toolId: string): boolean => BASH_FACADE_TARGETS.has(toolId);

export const withBashToolFacade = (ids: string[]): string[] => {
	let added = false;
	return ids.flatMap((id) => {
		if (!BASH_FACADE_TARGETS.has(id)) return [id];
		if (added) return [];
		added = true;
		return ["bash"];
	});
};

export interface WorkspaceMutationObserver {
	before(path: string): Promise<void>;
	after(path: string): Promise<void>;
	beforeWorkspace?(): Promise<void>;
	afterWorkspace?(): Promise<string[] | void>;
	coverage?(): "captured" | "incomplete";
	/** True when the latest beforeWorkspace/afterWorkspace pair recorded every workspace file without a capture failure. */
	workspaceCaptureComplete?(): boolean;
}

export class ToolExecutionError extends Error {
	constructor(message: string, readonly details: Record<string, unknown>, cause?: unknown) { super(message, { cause }); }
}

const rejectedWriteError = (error: unknown): ToolExecutionError => new ToolExecutionError(
	error instanceof Error ? error.message : String(error),
	{ resultKind: "failure", mutationRisk: "none", executionOutcome: "rejected-before-start" },
	error,
);

export interface WorkspaceWriteScope {
	wholeWorkspace: boolean;
	paths: string[];
}


/** The path parameter schema shared by workspace tools, including module tools. */
export const workspacePath = () => Type.String({
	minLength: 1,
	maxLength: 1_024,
	description: "Workspace-relative path or a path starting with /workspace.",
});

const listWorkspaceParameters = Type.Object({
	path: Type.Optional(workspacePath()),
	depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
}, { additionalProperties: false });

const searchWorkspaceParameters = Type.Object({
	query: Type.String({ minLength: 1, maxLength: 512 }),
	path: Type.Optional(workspacePath()),
	caseSensitive: Type.Optional(Type.Boolean()),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
	globs: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), { maxItems: 32 })),
}, { additionalProperties: false });

const inspectWorkspaceParameters = Type.Object({
	path: workspacePath(),
	offset: Type.Optional(Type.Integer({ minimum: 1 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
}, { additionalProperties: false });

const writeWorkspaceParameters = Type.Object({
	path: workspacePath(),
	content: Type.String({ maxLength: MAX_INPUT_BYTES }),
}, { additionalProperties: false });

const editWorkspaceParameters = Type.Object({
	path: workspacePath(),
	oldText: Type.String({ minLength: 1, maxLength: MAX_INPUT_BYTES }),
	newText: Type.String({ maxLength: MAX_INPUT_BYTES }),
	replaceAll: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

const runWorkspaceCommandParameters = Type.Object({
	argv: Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), { minItems: 1, maxItems: 64 }),
	cwd: Type.Optional(workspacePath()),
	timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
}, { additionalProperties: false });

const bashParameters = Type.Object({
	command: Type.String({ minLength: 1, maxLength: 16_000 }),
	cwd: Type.Optional(workspacePath()),
	timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
}, { additionalProperties: false });

const readToolOutputParameters = Type.Object({
	outputId: Type.String({ minLength: 36, maxLength: 36, pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" }),
	offset: Type.Optional(Type.Integer({ minimum: 0 })),
	limit: Type.Optional(Type.Integer({ minimum: 4, maximum: TOOL_OUTPUT_READ_LIMIT_BYTES })),
	pattern: Type.Optional(Type.String({ minLength: 1, maxLength: TOOL_OUTPUT_PATTERN_LIMIT })),
	contextLines: Type.Optional(Type.Integer({ minimum: 0, maximum: TOOL_OUTPUT_CONTEXT_LINE_LIMIT })),
}, { additionalProperties: false });

export const toolCacheDefinitions = {
	list_workspace: {
		name: "list_workspace",
		version: "1.0.0",
		description: "List files and directories inside the workspace. Use this to discover the project structure before reading files.",
		parameters: listWorkspaceParameters,
	},
	search_workspace: {
		name: "search_workspace",
		version: "2.0.0",
		description: "Search workspace text files for a literal substring and return matching lines with paths and line numbers. Set caseSensitive=true to match case exactly.",
		parameters: searchWorkspaceParameters,
	},
	inspect_workspace: {
		name: "inspect_workspace",
		version: "2.0.0",
		description: "Read a UTF-8 file inside the workspace. Use offset and limit to page through large files.",
		parameters: inspectWorkspaceParameters,
	},
	write_workspace: {
		name: "write_workspace",
		version: "1.0.0",
		description: "Create or replace a UTF-8 file inside the workspace atomically. Requires user approval.",
		parameters: writeWorkspaceParameters,
	},
	edit_workspace: {
		name: "edit_workspace",
		version: "1.0.0",
		description: "Replace exact text in an existing UTF-8 workspace file atomically. Fails on ambiguous matches unless replaceAll is true. Requires user approval.",
		parameters: editWorkspaceParameters,
	},
	run_workspace_command: {
		name: "run_workspace_command",
		version: "1.1.0",
		description: "Run an argv command from a workspace cwd with bounded output and filtered secrets. In ask/auto mode, Codex confines writes and disables network; full-access mode disables filesystem and network sandboxing. The active permission mode controls approval.",
		parameters: runWorkspaceCommandParameters,
	},
	bash: {
		name: "bash",
		version: "0.6.0",
		description: "Execute a Bash command in the selected workspace.",
		parameters: bashParameters,
	},
	read_tool_output: {
		name: "read_tool_output",
		version: "1.1.0",
		description: "Read a bounded UTF-8 byte range from a private command-output reference issued by this run or retained in this session. Use the exact nextOffset to continue, or pass pattern (case-insensitive literal text such as \"not ok\") with optional contextLines to get only matching lines with line numbers. This cannot read workspace or host paths.",
		parameters: readToolOutputParameters,
	},
} as const;

const throwIfAborted = (signal?: AbortSignal): void => {
	if (signal?.aborted) throw new Error("Operation aborted");
};

const workspaceRelativeRequest = (path: string): string => path === "/workspace"
	? "."
	: path.startsWith("/workspace/") ? path.slice("/workspace/".length) : path;

const assertNotPrivate = (target: string, privatePaths: readonly string[]): void => {
	if (privatePaths.some((path) => pathWithin(resolve(path), resolve(target)))) throw new Error("Path is private runtime state");
};

/** Resolves an existing path inside the workspace, refusing escapes, private runtime state and secrets. */
export async function resolveExistingInsideWorkspace(
	workspaceRoot: string,
	requestedPath: string,
	privatePaths: readonly string[] = [],
): Promise<{ root: string; target: string; relativePath: string }> {
	const lexicalRoot = resolve(workspaceRoot);
	const lexicalTarget = resolve(lexicalRoot, workspaceRelativeRequest(requestedPath));
	const lexicalRelative = relative(lexicalRoot, lexicalTarget);
	if (lexicalRelative.startsWith("..") || isAbsolute(lexicalRelative)) throw new Error("Path is outside the workspace");
	assertNotPrivate(lexicalTarget, privatePaths);
	const [root, target] = await Promise.all([realpath(lexicalRoot), realpath(lexicalTarget)]);
	const relativePath = relative(root, target);
	if (relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error("Path resolves outside the workspace");
	assertNotPrivate(target, privatePaths);
	if (PROTECTED_READ_DIRECTORIES.has(relativePath.split(/[\\/]/, 1)[0] ?? "")) throw new Error("Path is protected from workspace tools");
	if (isSensitiveWorkspacePath(relativePath)) throw new Error("Sensitive workspace paths are protected from agent tools");
	return { root, target, relativePath: relativePath || "." };
}

export async function readBoundedBytes(path: string, signal?: AbortSignal, maximum = MAX_INPUT_BYTES): Promise<Buffer> {
	throwIfAborted(signal);
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error("Path is not a file");
		if (info.nlink !== 1) throw new Error("Hard-linked files are not supported");
		if (info.size > maximum) throw new Error(`File exceeds ${maximum} bytes`);
		const bytes = Buffer.alloc(info.size + 1);
		let length = 0;
		while (length < bytes.length) {
			throwIfAborted(signal);
			const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > maximum) throw new Error(`File exceeds ${maximum} bytes`);
		return bytes.subarray(0, length);
	} finally {
		await handle.close();
	}
}

const readBoundedFile = async (path: string, signal?: AbortSignal): Promise<string> =>
	new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedBytes(path, signal));

async function resolveWritableInsideWorkspace(
	workspaceRoot: string,
	requestedPath: string,
	privatePaths: readonly string[] = [],
): Promise<{ root: string; target: string; relativePath: string }> {
	const lexicalRoot = resolve(workspaceRoot);
	const target = resolve(lexicalRoot, workspaceRelativeRequest(requestedPath));
	const lexicalRelative = relative(lexicalRoot, target);
	if (!lexicalRelative || lexicalRelative.startsWith("..") || isAbsolute(lexicalRelative)) {
		throw new Error("Write path is outside the workspace or names the workspace root");
	}
	assertNotPrivate(target, privatePaths);
	assertWritablePath(lexicalRelative);
	const root = await realpath(lexicalRoot);
	const canonicalTarget = resolve(root, lexicalRelative);
	assertNotPrivate(canonicalTarget, privatePaths);
	let ancestor = dirname(canonicalTarget);
	for (;;) {
		try {
			const realAncestor = await realpath(ancestor);
			const ancestorRelative = relative(root, realAncestor);
			if (ancestorRelative.startsWith("..") || isAbsolute(ancestorRelative)) throw new Error("Write path resolves outside the workspace");
			const resolvedTarget = join(realAncestor, relative(ancestor, canonicalTarget));
			assertNotPrivate(resolvedTarget, privatePaths);
			assertWritablePath(join(ancestorRelative, relative(ancestor, canonicalTarget)));
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = dirname(ancestor);
			if (parent === ancestor) throw new Error("Could not resolve a workspace ancestor");
			ancestor = parent;
		}
	}
	if (isSensitiveWorkspacePath(lexicalRelative)) throw new Error("Sensitive workspace paths are protected from agent tools");
	return { root, target: canonicalTarget, relativePath: lexicalRelative };
}

async function atomicWriteWorkspaceFile(
	workspaceRoot: string,
	requestedPath: string,
	content: string,
	signal?: AbortSignal,
	observer?: WorkspaceMutationObserver,
	writeScope?: WorkspaceWriteScope,
	privatePaths: readonly string[] = [],
): Promise<{ path: string; bytes: number; changed: boolean }> {
	let resolved: Awaited<ReturnType<typeof resolveWritableInsideWorkspace>>;
	const bytes = Buffer.byteLength(content);
	let mode = 0o644;
	let changed = true;
	try {
		throwIfAborted(signal);
		if (bytes > MAX_INPUT_BYTES) throw new Error(`Content exceeds ${MAX_INPUT_BYTES} bytes`);
		resolved = await resolveWritableInsideWorkspace(workspaceRoot, requestedPath, privatePaths);
		assertWriteAllowed(resolved.target, writeScope);
	} catch (error) { throw rejectedWriteError(error); }
	let existing: Stats | undefined;
	try { existing = await lstat(resolved.target); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw rejectedWriteError(error);
	}
	if (existing) try {
		if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("Write target must be a regular file");
		if (existing.nlink !== 1) throw new Error("Hard-linked files are not supported");
		mode = existing.mode & 0o777;
		changed = await readBoundedFile(resolved.target, signal) !== content;
	} catch (error) { throw rejectedWriteError(error); }
	if (!changed) return { path: resolved.relativePath, bytes, changed: false };
	try { await observer?.before(resolved.relativePath); }
	catch (error) { throw new ToolExecutionError("Write checkpoint capture failed before start", { resultKind: "failure", mutationRisk: "none", executionOutcome: "rejected-before-start" }, error); }
	let primaryError: unknown;
	let temporary: string | undefined;
	try {
		let realParent = dirname(resolved.target);
		await mkdir(realParent, { recursive: true });
		realParent = await realpath(realParent);
		const parentRelative = relative(resolved.root, realParent);
		if (parentRelative.startsWith("..") || isAbsolute(parentRelative)) throw new Error("Write path resolves outside the workspace");
		assertNotPrivate(join(realParent, basename(resolved.target)), privatePaths);
		assertWritablePath(join(parentRelative, basename(resolved.target)));
		temporary = join(realParent, `.${basename(resolved.target)}.codetonomy-${randomUUID()}.tmp`);
		const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
		try {
			throwIfAborted(signal);
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		throwIfAborted(signal);
		await rename(temporary, resolved.target);
	} catch (error) {
		primaryError = error;
		throw error;
	} finally {
		if (temporary) await unlink(temporary).catch(() => undefined);
		try { await observer?.after(resolved.relativePath); }
		catch (error) { if (!primaryError) throw new ToolExecutionError("Write settled but checkpoint capture failed; inspect current state", { resultKind: "failure", mutationRisk: "possible", executionOutcome: "effects-unknown", rewindCoverage: "incomplete" }, error); }
	}
	return { path: resolved.relativePath, bytes, changed };
}

function pathWithin(root: string, path: string): boolean {
	const candidate = relative(root, path);
	return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate));
}

const assertWriteAllowed = (target: string, scope?: WorkspaceWriteScope): void => {
	if (!scope || scope.wholeWorkspace) return;
	if (!scope.paths.some((root) => pathWithin(root, target))) throw new Error("Write path is outside the child agent's declared write claim");
};

async function* walkWorkspace(
	root: string,
	start: string,
	maximumDepth: number,
	signal?: AbortSignal,
	privatePaths: readonly string[] = [],
): AsyncGenerator<{ path: string; relativePath: string; directory: boolean; depth: number }> {
	const queue = [{ path: start, depth: 0 }];
	while (queue.length) {
		throwIfAborted(signal);
		const current = queue.shift()!;
		const directory = await opendir(current.path);
		const entries = [];
		for await (const entry of directory) entries.push(entry);
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			throwIfAborted(signal);
			if (entry.isSymbolicLink() || (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name))) continue;
			const path = join(current.path, entry.name);
			if (privatePaths.some((privatePath) => pathWithin(resolve(privatePath), path))) continue;
			const relativePath = relative(root, path);
			if (isSensitiveWorkspacePath(relativePath)) continue;
			yield { path, relativePath, directory: entry.isDirectory(), depth: current.depth };
			if (entry.isDirectory() && current.depth < maximumDepth) queue.push({ path, depth: current.depth + 1 });
		}
	}
}

const matchesWorkspaceGlobs = (path: string, globs: readonly string[] | undefined): boolean => {
	if (!globs?.length) return true;
	const normalized = displayPath(path);
	let included = !globs.some((glob) => !glob.startsWith("!"));
	for (const rule of globs) {
		const excluded = rule.startsWith("!");
		const pattern = excluded ? rule.slice(1) : rule;
		if (!pattern) continue;
		if (matchesGlob(normalized, pattern) || (!pattern.includes("/") && matchesGlob(basename(normalized), pattern))) included = !excluded;
	}
	return included;
};

export const truncateUtf8 = (value: string, maximumBytes = MAX_OUTPUT_BYTES): { text: string; truncated: boolean } => {
	const bytes = Buffer.from(value);
	if (bytes.length <= maximumBytes) return { text: value, truncated: false };
	let end = maximumBytes;
	while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end--;
	return { text: `${bytes.subarray(0, end).toString("utf8")}\n\n[Output truncated at ${maximumBytes} bytes]`, truncated: true };
};

const queryMatchOffset = (text: string, query: string): number => {
	const lower = text.toLocaleLowerCase();
	const exact = lower.indexOf(query.trim().toLocaleLowerCase());
	if (exact >= 0) return exact;
	for (const term of [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])].sort((left, right) => right.length - left.length)) {
		if (term.length < 2) continue;
		const offset = lower.indexOf(term);
		if (offset >= 0) return offset;
	}
	return -1;
};

// Adapted from Reasonix MakeSnippet: compact whitespace and center the excerpt on the query.
export const queryExcerpt = (text: string, query: string, maximum = 240): string => {
	const compact = text.replaceAll(/\s+/g, " ").trim();
	if (compact.length <= maximum) return compact;
	const offset = Math.max(0, queryMatchOffset(compact, query));
	const start = Math.max(0, Math.min(offset - Math.floor(maximum / 2), compact.length - maximum));
	return `${start ? "… " : ""}${compact.slice(start, start + maximum).trim()}${start + maximum < compact.length ? " …" : ""}`;
};

export function listWorkspaceTool(workspaceRoot: string, privatePaths: readonly string[] = []): AgentTool<typeof listWorkspaceParameters> {
	return {
		name: "list_workspace",
		label: "List workspace",
		description: toolCacheDefinitions.list_workspace.description,
		parameters: listWorkspaceParameters,
		executionMode: "parallel",
		async execute(_toolCallId, { path = ".", depth = 2, limit = 200 }, signal) {
			const resolved = await resolveExistingInsideWorkspace(workspaceRoot, path, privatePaths);
			if (!(await lstat(resolved.target)).isDirectory()) throw new Error("Path is not a directory");
			const lines: string[] = [];
			let limited = false;
			for await (const entry of walkWorkspace(resolved.root, resolved.target, depth, signal, privatePaths)) {
				if (lines.length === limit) {
					limited = true;
					break;
				}
				lines.push(`${displayPath(entry.relativePath)}${entry.directory ? "/" : ""}`);
			}
			const raw = lines.length ? lines.join("\n") : "(empty directory)";
			const suffix = limited ? `\n\n[Entry limit ${limit} reached]` : "";
			const output = truncateUtf8(raw + suffix);
			return { content: [{ type: "text", text: output.text }], details: { entries: lines.length, truncated: limited || output.truncated } };
		},
	};
}

export function searchWorkspaceTool(workspaceRoot: string, privatePaths: readonly string[] = []): AgentTool<typeof searchWorkspaceParameters> {
	return {
		name: "search_workspace",
		label: "Search workspace",
		description: toolCacheDefinitions.search_workspace.description,
		parameters: searchWorkspaceParameters,
		executionMode: "parallel",
		async execute(_toolCallId, { query, path = ".", caseSensitive = false, limit = 100, globs }, signal) {
			const resolved = await resolveExistingInsideWorkspace(workspaceRoot, path, privatePaths);
			const targetInfo = await lstat(resolved.target);
			const needle = caseSensitive ? query : query.toLocaleLowerCase();
			const matches: string[] = [];
			const sourceRefs = new Map<string, { path: string; sourceHash: string }>();
			let searchedFiles = 0;
			let limited = false;
			const candidates = targetInfo.isDirectory()
				? walkWorkspace(resolved.root, resolved.target, Number.MAX_SAFE_INTEGER, signal, privatePaths)
				: (async function* () { yield { path: resolved.target, relativePath: resolved.relativePath, directory: false, depth: 0 }; })();

			for await (const candidate of candidates) {
				if (candidate.directory) continue;
				if (!matchesWorkspaceGlobs(candidate.relativePath, globs)) continue;
				if (++searchedFiles > MAX_SEARCHED_FILES) {
					limited = true;
					break;
				}
				let bytes: Buffer;
				let content: string;
				try {
					bytes = await readBoundedBytes(candidate.path, signal);
					content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
				} catch (error) {
					if (signal?.aborted) throw error;
					continue;
				}
				const matchesBeforeFile = matches.length;
				const lines = content.split("\n");
				for (let index = 0; index < lines.length; index++) {
					const line = lines[index] ?? "";
					const haystack = caseSensitive ? line : line.toLocaleLowerCase();
					if (!haystack.includes(needle)) continue;
					matches.push(`${displayPath(candidate.relativePath)}:${index + 1}: ${line.slice(0, 500)}`);
					if (matches.length === limit) {
						limited = true;
						break;
					}
				}
				if (matches.length > matchesBeforeFile && sourceRefs.size < 16) {
					const sourcePath = displayPath(candidate.relativePath);
					sourceRefs.set(sourcePath, { path: sourcePath, sourceHash: createHash("sha256").update(bytes).digest("hex") });
				}
				if (limited) break;
			}
			const raw = matches.length ? matches.join("\n") : "No matches found";
			const suffix = limited ? `\n\n[Search limit reached after ${searchedFiles} files and ${matches.length} matches]` : "";
			const output = truncateUtf8(raw + suffix);
			return {
				content: [{ type: "text", text: output.text }],
				details: {
					backend: "literal",
					searchedFiles,
					matches: matches.length,
					truncated: limited || output.truncated,
					sourceRefs: [...sourceRefs.values()],
				},
			};
		},
	};
}

// One inspect_workspace page within MAX_OUTPUT_BYTES, notes included. A window that fits is returned as is;
// otherwise the page ends on the last whole line that fits with the continuation notice, so paging never skips
// a line. Only a first line that cannot fit with its page's notes is clipped, and the next page starts after it.
const inspectPage = (lines: string[], offset: number, limit: number): { text: string; nextOffset?: number; clipped: boolean } => {
	const notice = (last: number) => last < lines.length ? `\n\n[Showing lines ${offset}-${last} of ${lines.length}. Continue with offset=${last + 1}.]` : "";
	const next = (last: number) => last < lines.length ? last + 1 : undefined;
	const windowEnd = Math.min(offset - 1 + limit, lines.length);
	const window = lines.slice(offset - 1, windowEnd).join("\n") + notice(windowEnd);
	if (Buffer.byteLength(window) <= MAX_OUTPUT_BYTES) return { text: window, nextOffset: next(windowEnd), clipped: false };
	let last = offset - 1;
	for (let bytes = -1; last < windowEnd; last++) {
		bytes += 1 + Buffer.byteLength(lines[last]!);
		if (bytes + Buffer.byteLength(notice(last + 1)) > MAX_OUTPUT_BYTES) break;
	}
	if (last >= offset) return { text: lines.slice(offset - 1, last).join("\n") + notice(last), nextOffset: next(last), clipped: false };
	const line = Buffer.from(lines[offset - 1]!);
	const note = (shown: number) => `\n\n[Line ${offset} clipped: showing the first ${shown} of ${line.length} bytes]`;
	let end = MAX_OUTPUT_BYTES - Buffer.byteLength(note(line.length) + notice(offset));
	while (end > 0 && ((line[end] ?? 0) & 0xc0) === 0x80) end--;
	return { text: line.subarray(0, end).toString("utf8") + note(end) + notice(offset), nextOffset: next(offset), clipped: true };
};

export function inspectWorkspaceTool(workspaceRoot: string, privatePaths: readonly string[] = []): AgentTool<typeof inspectWorkspaceParameters> {
	return {
		name: "inspect_workspace",
		label: "Inspect workspace file",
		description: toolCacheDefinitions.inspect_workspace.description,
		parameters: inspectWorkspaceParameters,
		executionMode: "parallel",
		async execute(_toolCallId, { path, offset = 1, limit = 400 }, signal) {
			const resolved = await resolveExistingInsideWorkspace(workspaceRoot, path, privatePaths);
			const bytes = await readBoundedBytes(resolved.target, signal);
			const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			const sourceHash = createHash("sha256").update(bytes).digest("hex");
			const lines = content.split("\n");
			if (offset > lines.length) throw new Error(`Offset ${offset} is beyond end of file (${lines.length} lines)`);
			const page = inspectPage(lines, offset, limit);
			return {
				content: [{ type: "text", text: page.text }],
				details: { path: resolved.relativePath, offset, limit, totalLines: lines.length, nextOffset: page.nextOffset, sourceHash, truncated: page.clipped || Boolean(page.nextOffset) },
			};
		},
	};
}

export function writeWorkspaceTool(workspaceRoot: string, observer?: WorkspaceMutationObserver, writeScope?: WorkspaceWriteScope, privatePaths: readonly string[] = []): AgentTool<typeof writeWorkspaceParameters> {
	return {
		name: "write_workspace",
		label: "Write workspace file",
		description: toolCacheDefinitions.write_workspace.description,
		parameters: writeWorkspaceParameters,
		executionMode: "sequential",
		async execute(_toolCallId, { path, content }, signal) {
			const result = await atomicWriteWorkspaceFile(workspaceRoot, path, content, signal, observer, writeScope, privatePaths);
			const text = result.changed ? `Wrote ${result.bytes} bytes to ${result.path}` : `No change: ${result.path} already has this content (0 bytes written)`;
			return { content: [{ type: "text", text }], details: result };
		},
	};
}

export function editWorkspaceTool(workspaceRoot: string, observer?: WorkspaceMutationObserver, writeScope?: WorkspaceWriteScope, privatePaths: readonly string[] = []): AgentTool<typeof editWorkspaceParameters> {
	return {
		name: "edit_workspace",
		label: "Edit workspace file",
		description: toolCacheDefinitions.edit_workspace.description,
		parameters: editWorkspaceParameters,
		executionMode: "sequential",
		async execute(_toolCallId, { path, oldText, newText, replaceAll = false }, signal) {
			let existing: Awaited<ReturnType<typeof resolveExistingInsideWorkspace>>;
			let content: string;
			try {
				existing = await resolveExistingInsideWorkspace(workspaceRoot, path, privatePaths);
				content = await readBoundedFile(existing.target, signal);
			} catch (error) { throw rejectedWriteError(error); }
			const occurrences = content.split(oldText).length - 1;
			if (occurrences === 0) throw new ToolExecutionError("oldText was not found in the target file; inspect the current text before correcting the edit", { resultKind: "failure", mutationRisk: "none", executionOutcome: "rejected-before-start" });
			if (occurrences > 1 && !replaceAll) throw new ToolExecutionError(`oldText matched ${occurrences} locations; provide a unique match or set replaceAll`, { resultKind: "failure", mutationRisk: "none", executionOutcome: "rejected-before-start" });
			const updated = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, () => newText);
			const result = await atomicWriteWorkspaceFile(workspaceRoot, path, updated, signal, observer, writeScope, privatePaths);
			return {
				content: [{ type: "text", text: result.changed
					? `Edited ${result.path} (${replaceAll ? occurrences : 1} replacement${occurrences === 1 ? "" : "s"})`
					: `No change: newText is identical to the matched text in ${result.path}` }],
				details: { ...result, replacements: replaceAll ? occurrences : 1 },
			};
		},
	};
}

export type CommandSandboxMode = "read-only" | "workspace" | "full-access";

export interface SandboxCommandOptions {
	codexBinary?: string;
	observer?: WorkspaceMutationObserver;
	commandSandboxMode?: CommandSandboxMode;
	allowArgumentLineBreaks?: boolean;
	outputStore?: CommandOutputStore;
	privatePaths?: readonly string[];
	sandboxWorkspaceRoot?: string;
	sandboxPath?: string;
}

export type RunOwnedCommandOptions = SandboxCommandOptions & { outputStore: CommandOutputStore };

const resolveHostExecutable = (program: string): string | undefined => {
	if (isAbsolute(program)) return program;
	if (program.includes("/") || program.includes("\\")) return resolve(program);
	const suffixes = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE").split(";")] : [""];
	for (const directory of (process.env.PATH ?? "").split(delimiter)) for (const suffix of suffixes) try {
		const candidate = join(directory || process.cwd(), `${program}${suffix}`);
		if (!statSync(candidate).isFile()) continue;
		accessSync(candidate, constants.X_OK);
		return realpathSync.native(candidate);
	} catch {}
	return undefined;
};

// Resolve the pinned npm package's native entry point before restricting PATH.
// Its JavaScript launcher needs Node on PATH, which semantic commands restrict.
const nativeCodexEntry = (program: string): string => {
	try {
		const launcher = realpathSync.native(program);
		if (basename(launcher) !== "codex.js") return program;
		const packageJson = createRequire(launcher).resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`);
		const vendor = join(dirname(packageJson), "vendor");
		const candidates = readdirSync(vendor).map((target) => join(vendor, target, "bin", process.platform === "win32" ? "codex.exe" : "codex")).filter(existsSync);
		if (candidates.length === 1) return candidates[0]!;
	} catch {}
	return program;
};

export const resolveCodexBinary = (explicit?: string): string => {
	if (explicit) return nativeCodexEntry(resolveHostExecutable(explicit) ?? explicit);
	if (process.env.CODETONOMY_CODEX_BIN) return nativeCodexEntry(resolveHostExecutable(process.env.CODETONOMY_CODEX_BIN) ?? process.env.CODETONOMY_CODEX_BIN);
	const workerRoots = [
		process.env.CODETONOMY_WORKER_ROOT,
		process.env.CODETONOMY_HOME ? join(process.env.CODETONOMY_HOME, "workers") : undefined,
		join(homedir(), ".codetonomy", "workers"),
	].filter((value): value is string => Boolean(value));
	const windowsTarget = process.arch === "arm64" ? ["codex-win32-arm64", "aarch64-pc-windows-msvc"] : ["codex-win32-x64", "x86_64-pc-windows-msvc"];
	const workerCandidates = workerRoots.flatMap((root) => process.platform === "win32"
		? [join(root, "codex", "node_modules", `@openai/${windowsTarget[0]}`, "vendor", windowsTarget[1]!, "bin", "codex.exe")]
		: [join(root, "codex", "node_modules", ".bin", "codex")]);
	let desktopCandidates: string[] = [];
	if (process.platform === "win32" && process.env.LOCALAPPDATA) {
		const desktopBin = join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
		try {
			desktopCandidates = readdirSync(desktopBin, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(desktopBin, entry.name, "codex.exe"))
				.filter(existsSync)
				.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
		} catch {}
	}
	const candidates = [...workerCandidates, ...desktopCandidates];
	return nativeCodexEntry(candidates.find(existsSync) ?? resolveHostExecutable("codex") ?? "codex");
};

const sandboxRuntimeReadPaths = (): string[] => {
	const codexBinary = resolveCodexBinary();
	const codexDirectory = isAbsolute(codexBinary) ? dirname(codexBinary) : undefined;
	const codexInstallation = codexDirectory && basename(codexDirectory) === ".bin" ? dirname(codexDirectory) : codexDirectory;
	return [...new Set([
		dirname(process.execPath),
		codexInstallation,
		...(process.platform === "darwin" ? ["/System/Library/OpenSSL"] : []),
	].filter((path): path is string => Boolean(path)))];
};

const SANDBOX_ENVIRONMENT = /^(?:PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TEMP|TMP|TERM|COLORTERM|NO_COLOR|FORCE_COLOR|LANG|LC_.+|CODEX_HOME|RUST_LOG|RUST_BACKTRACE|SystemRoot|WINDIR|PATHEXT|ComSpec)$/;

// Windows environment names are case-insensitive; a parent shell may spell ComSpec as COMSPEC.
// Without it npm cannot start package scripts and exits 1 with no diagnostic.
const SANDBOX_ENVIRONMENT_WIN32 = new RegExp(SANDBOX_ENVIRONMENT.source, "i");

export const filterSandboxEnvironment = (environment: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv => {
	const allowed = Object.entries(environment).filter(([name, value]) => value !== undefined && (platform === "win32" ? SANDBOX_ENVIRONMENT_WIN32 : SANDBOX_ENVIRONMENT).test(name));
	if (platform !== "win32") return Object.fromEntries(allowed);
	// Keep one spelling per name; a later entry such as an explicit PATH override wins over an inherited Path.
	return Object.fromEntries([...new Map(allowed.map((entry) => [entry[0].toUpperCase(), entry])).values()]);
};

export const normalizeWorkspaceCommandArgv = (argv: string[]): string[] => {
	if (process.platform !== "win32" || !/^npm(?:\.cmd)?$/i.test(argv[0] ?? "")) return argv;
	const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
	return existsSync(npmCli) ? [process.execPath, npmCli, ...argv.slice(1)] : argv;
};

export function createCodexSandboxInvocation(
	cwd: string,
	argv: string[],
	{ commandSandboxMode = "workspace", privatePaths = [], sandboxWorkspaceRoot }: Pick<SandboxCommandOptions, "commandSandboxMode" | "privatePaths" | "sandboxWorkspaceRoot"> = {},
): string[] {
	const sandboxCwd = pathToFileURL(cwd).href;
	const platformConfiguration = process.platform === "win32" ? ["-c", 'windows.sandbox="elevated"'] : [];
	if (commandSandboxMode === "full-access") {
		return [
			"sandbox",
			"--sandbox-state-json",
			JSON.stringify({
				permissionProfile: { type: "disabled" },
				codexLinuxSandboxExe: null,
				sandboxCwd,
				useLegacyLandlock: false,
			}),
			...platformConfiguration,
			"-c",
			"shell_environment_policy.inherit=core",
			"-c",
			"shell_environment_policy.ignore_default_excludes=false",
			"--",
			...argv,
		];
	}
	const workspaceRoot = resolve(sandboxWorkspaceRoot ?? cwd);
	if (commandSandboxMode === "read-only" && sandboxPlatformDefaultsOverlap(workspaceRoot)) {
		throw new Error("The native macOS sandbox cannot enforce a read-only workspace overlapping system temporary directories");
	}
	const protectedPaths = [".git", ".agents", ".codex", ".codetonomy", ".harness", ".pnpm-store", "node_modules"].map((name) => ({
		path: { type: "path", path: join(workspaceRoot, name) },
		access: commandSandboxMode === "read-only" ? "deny" : "read",
		missing_path_behavior: "skip",
	}));
	// Deny the configuration (credentials) even at its default location: on Windows, Codex's full-read
	// setup grants the shared sandbox accounts read access to every top-level profile folder.
	const configurationRoot = process.env.CODETONOMY_HOME?.trim() || join(homedir(), ".codetonomy");
	if ([COMMAND_OUTPUT_ROOT, ...privatePaths, ...(configurationRoot && isAbsolute(configurationRoot) ? [configurationRoot] : [])].some(sandboxPlatformDefaultsOverlap)) {
		throw new Error("Native macOS sandbox platform defaults overlap private state; use state and output directories outside system temporary directories");
	}
	const privateConfigurationPath = configurationRoot && isAbsolute(configurationRoot) ? [{
		path: { type: "path", path: resolve(configurationRoot) },
		access: "deny",
		missing_path_behavior: "skip",
	}] : [];
	const privateOutputPaths = [...new Set([COMMAND_OUTPUT_ROOT, ...privatePaths].filter(isAbsolute))].map((path) => ({
		path: { type: "path", path: resolve(path) },
		access: "deny",
		missing_path_behavior: "skip",
	}));
	// A denied parent already covers its descendants; nested deny mounts fail in bubblewrap.
	const denyEntries = [...privateConfigurationPath, ...protectedPaths.filter(({ access }) => access === "deny"), ...privateOutputPaths];
	const minimalDenyEntries = denyEntries.filter((entry, index) => !denyEntries.some((parent, parentIndex) =>
		parentIndex !== index && pathWithin(parent.path.path, entry.path.path)
		&& (parent.path.path !== entry.path.path || parentIndex < index)));
	const bashExecutable = resolveBashExecutable();
	const bashDirectory = isAbsolute(bashExecutable) ? dirname(bashExecutable) : undefined;
	const bashInstallationRoot = bashInstallationRootOf(bashExecutable);
	const toolchainReadPaths = [...new Set([
		...(process.env.PATH ?? "").split(delimiter),
		...sandboxRuntimeReadPaths(),
		bashDirectory,
		bashInstallationRoot,
	].filter((path): path is string => typeof path === "string" && isAbsolute(path)))].map((path) => ({
		path: { type: "path", path },
		access: "read",
		missing_path_behavior: "skip",
	}));
	const workspaceAccess = {
		path: { type: "path", path: workspaceRoot },
		access: commandSandboxMode === "read-only" ? "read" : "write",
		missing_path_behavior: "skip",
	};
	const state = {
		permissionProfile: {
			type: "managed",
			file_system: {
				type: "restricted",
				entries: [
					{ path: { type: "special", value: { kind: "minimal" } }, access: "read" },
					...toolchainReadPaths,
					workspaceAccess,
					{ path: { type: "special", value: { kind: "project_roots" } }, access: commandSandboxMode === "read-only" ? "read" : "write" },

					...(commandSandboxMode === "read-only" ? [] : process.platform === "win32" ? [
						// The pinned Windows special tmpdir expansion drops nested exclusions.
						{ path: { type: "path", path: realpathSync.native(tmpdir()) }, access: "write", missing_path_behavior: "skip" },
					] : [
						{ path: { type: "special", value: { kind: "tmpdir" } }, access: "write" },
						{ path: { type: "special", value: { kind: "slash_tmp" } }, access: "write" },
					]),
					...protectedPaths.filter(({ access }) => access !== "deny"),
					...minimalDenyEntries,
				],
			},
			network: "restricted",
		},
		codexLinuxSandboxExe: null,
		sandboxCwd,
		useLegacyLandlock: false,
	};
	return [
		"sandbox",
		"--sandbox-state-json",
		JSON.stringify(state),
		"--sandbox-state-disable-network",
		...platformConfiguration,
		"-c",
		"shell_environment_policy.inherit=core",
		"-c",
		"shell_environment_policy.ignore_default_excludes=false",
		"--",
		...argv,
	];
}

async function discoverSensitiveWorkspacePaths(root: string, signal?: AbortSignal): Promise<string[]> {
	// Search exclusions are still readable by commands, so scan them and linked directories too.
	const paths: string[] = [];
	const queue = [root];
	const visited = new Set<string>();
	let scanned = 0;
	while (queue.length) {
		if (signal?.aborted) throw signal.reason ?? new Error("Command aborted");
		const directory = await realpath(queue.shift()!);
		if (visited.has(directory)) continue;
		visited.add(directory);
		for await (const entry of await opendir(directory)) {
			if (++scanned > MAX_WORKSPACE_SCAN_ENTRIES) throw new Error(`Sensitive-path scan exceeds ${MAX_WORKSPACE_SCAN_ENTRIES} workspace entries`);
			const path = join(directory, entry.name);
			if (isSensitiveWorkspacePath(relative(root, path))) paths.push(path);
			else if (entry.isSymbolicLink()) {
				const target = await realpath(path);
				if (isSensitiveWorkspacePath(target)) paths.push(path);
				else if ((await lstat(target)).isDirectory()) queue.push(target);
			} else if (entry.isDirectory()) queue.push(path);
		}
	}
	return paths;
}

const renderCommandReceipt = (details: Record<string, unknown>, knownSecrets: readonly string[] = []): string => {
	const bounded = { ...details };
	if (Array.isArray(bounded.argv)) bounded.argv = bounded.argv.slice(0, 8).map((value) => redactAuditString(String(value).slice(0, 128), knownSecrets));
	if (typeof bounded.cwd === "string") bounded.cwd = redactAuditString(bounded.cwd, knownSecrets);
	if (typeof bounded.command === "string") bounded.command = redactAuditString(bounded.command.slice(0, 1_024), knownSecrets);
	return `[Command receipt: ${JSON.stringify(Object.fromEntries([
		"argv", "cwd", "command", "exitCode", "resultKind", "mutationRisk", "capturedBytes", "readableBytes", "previewTruncated", "omittedBytes", "outputComplete", "outputId",
	].flatMap((field) => bounded[field] === undefined ? [] : [[field, bounded[field]]])))}]`;
};

/**
 * Codex's Windows sandbox grants read ACLs from a background helper (skipped while another is
 * running), so the sandbox account's logon can fail with 267 (invalid directory) or 5 (access
 * denied) before the command starts. The command never ran, so retrying after a short wait is safe.
 */
export const WINDOWS_SANDBOX_LAUNCH_FAILURE = /^windows sandbox failed: CreateProcessWithLogonW failed: (?:5|267)\s*$/;
const SANDBOX_LAUNCH_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000];

export async function retryWindowsSandboxLaunch<T>(attempt: () => Promise<T>, launchFailed: (result: T) => boolean, signal?: AbortSignal): Promise<T> {
	let result = await attempt();
	for (const delay of process.platform === "win32" ? SANDBOX_LAUNCH_RETRY_DELAYS_MS : []) {
		if (!launchFailed(result)) break;
		await new Promise<void>((resolveWait, rejectWait) => {
			const timer = setTimeout(resolveWait, delay);
			signal?.addEventListener("abort", () => { clearTimeout(timer); rejectWait(signal.reason); }, { once: true });
		});
		result = await attempt();
	}
	return result;
}

const runSandboxedProcess = (attempt: () => ReturnType<typeof runBoundedProcess>, signal?: AbortSignal) => retryWindowsSandboxLaunch(
	attempt,
	(result) => result.exitCode !== 0 && WINDOWS_SANDBOX_LAUNCH_FAILURE.test(result.receipt.output.trim()),
	signal,
);

async function runBoundedProcess(
	program: string,
	args: string[],
	cwd: string,
	timeoutSeconds: number,
	outputStore: CommandOutputStore,
	originCallId: string,
	sandboxPath?: string,
	signal?: AbortSignal,
): Promise<{ exitCode: number | null; receipt: Awaited<ReturnType<ReturnType<CommandOutputStore["createCapture"]>["finish"]>>; processStarted: boolean }> {
	throwIfAborted(signal);
	const capture = outputStore.createCapture(originCallId);
	return new Promise((resolveProcess, rejectProcess) => {
		const child = spawn(program, args, {
			cwd,
			detached: process.platform !== "win32",
			env: filterSandboxEnvironment(sandboxPath === undefined ? process.env : { ...process.env, PATH: sandboxPath }),
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let failure: Error | undefined;
		let captureFailed = false;
		let outputWrite = Promise.resolve();
		let pendingOutputWrites = 0;
		let killTimer: NodeJS.Timeout | undefined;
		let killedOnExit = false;
		const killTree = (force: boolean) => {
			if (!child.pid) return;
			if (process.platform === "win32") {
				const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], { stdio: "ignore", windowsHide: true });
				const fallback = () => { try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch {} };
				killer.once("error", fallback);
				killer.once("close", (code) => { if (code !== 0) fallback(); });
				return;
			}
			try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); } catch {}
		};
		const terminate = (error: Error) => {
			if (failure) return;
			failure = error;
			killTree(false);
			killTimer = setTimeout(() => {
				killTree(true);
			}, 1_000);
			killTimer.unref();
		};
		const onData = (chunk: Buffer) => {
			if (failure) return;
			child.stdout.pause();
			child.stderr.pause();
			const bytes = Buffer.from(chunk);
			pendingOutputWrites++;
			outputWrite = outputWrite
				.then(() => captureFailed ? undefined : capture.append(bytes))
				.catch((error) => {
					captureFailed = true;
					terminate(error instanceof Error ? error : new Error(String(error)));
				})
				.finally(() => {
					pendingOutputWrites--;
					if (!failure && pendingOutputWrites === 0) {
						child.stdout.resume();
						child.stderr.resume();
					}
				});
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		const onAbort = () => terminate(new Error("Command aborted"));
		signal?.addEventListener("abort", onAbort, { once: true });
		const timeout = setTimeout(() => terminate(new Error(`Command timed out after ${timeoutSeconds} seconds`)), timeoutSeconds * 1_000);
		timeout.unref();
		child.once("error", terminate);
		child.once("exit", () => {
			killedOnExit = true;
			// After a termination we requested, the Codex launcher and its CLI exit at once while the Linux
			// sandbox helper is still stopping bubblewrap and removing its mount placeholders from the temp
			// directory; force-killing the group now leaves them behind. The escalation timer still bounds
			// the wait, and the group is force-killed once the helper releases stdio (on close).
			if (!failure) killTree(true);
		});
		child.once("close", async (exitCode) => {
			clearTimeout(timeout);
			if (killTimer) clearTimeout(killTimer);
			if (!killedOnExit || failure) killTree(true);
			signal?.removeEventListener("abort", onAbort);
			await outputWrite;
			let receipt;
			try { receipt = await capture.finish(!failure); }
			catch (error) {
				failure ??= error instanceof Error ? error : new Error(String(error));
				receipt = { output: "[Captured output unavailable]", capturedBytes: 0, previewTruncated: false, omittedBytes: 0, outputComplete: false, storageFailure: true };
			}
			if (receipt.storageFailure) failure ??= new CommandOutputCaptureError("Private command output storage failed", "storage");
			const processStarted = Boolean(child.pid);
			if (failure) rejectProcess(new ToolExecutionError(failure.message, { exitCode, processStarted, ...receipt }, failure));
			else resolveProcess({ exitCode, receipt, processStarted });
		});
	});
}

export function runWorkspaceCommandTool(
	workspaceRoot: string,
	options: RunOwnedCommandOptions,
): AgentTool<typeof runWorkspaceCommandParameters> {
	const outputStore = options.outputStore;
	return {
		name: "run_workspace_command",
		label: "Run sandboxed workspace command",
		description: toolCacheDefinitions.run_workspace_command.description,
		parameters: runWorkspaceCommandParameters,
		executionMode: "sequential",
		async execute(toolCallId, { argv, cwd = ".", timeoutSeconds = 120 }, signal) {
			const commandSandboxMode = options.commandSandboxMode ?? "workspace";
			const privatePaths = [...(options.privatePaths ?? []), ...outputStore.privatePaths()];
			const preflightStarted = performance.now();
			let resolved: Awaited<ReturnType<typeof resolveExistingInsideWorkspace>>;
			let invocation: string[];
			try {
				if (argv.some((argument) => argument.includes("\u0000") || (!options.allowArgumentLineBreaks && /[\r\n]/.test(argument)))) throw new Error("Command arguments cannot contain control line breaks");
				resolved = await resolveExistingInsideWorkspace(workspaceRoot, cwd, privatePaths);
				if (!(await lstat(resolved.target)).isDirectory()) throw new Error("Command cwd is not a directory");
				const sensitivePaths = commandSandboxMode === "full-access" ? [] : await discoverSensitiveWorkspacePaths(resolved.root, signal);
				if (sensitivePaths.length) throw new Error(`Sandboxed workspace commands are blocked while ${sensitivePaths.length} sensitive path${sensitivePaths.length === 1 ? " is" : "s are"} present; use structured tools or explicitly authorized full-access mode`);
				await outputStore.prepare();
				// The sandbox denies the shared output root; it must exist first (see ensureCommandOutputRoot).
				if (commandSandboxMode !== "full-access") await ensureCommandOutputRoot();
				invocation = createCodexSandboxInvocation(resolved.target, normalizeWorkspaceCommandArgv(argv), {
					commandSandboxMode,
					privatePaths,
					sandboxWorkspaceRoot: resolved.root,
				});
			} catch (error) {
				const details = {
					argv,
					cwd,
					resultKind: "failure" satisfies CommandResultKind,
					mutationRisk: "none" satisfies CommandMutationRisk,
					executionOutcome: "rejected-before-start",
					capturedBytes: 0,
					previewTruncated: false,
					omittedBytes: 0,
					outputComplete: false,
					preflightDurationMs: Math.round((performance.now() - preflightStarted) * 100) / 100,
					checkpointDurationMs: 0,
					subprocessDurationMs: 0,
					renderingDurationMs: 0,
					checkpointCount: 0,
				};
				const message = error instanceof Error ? error.message : String(error);
				throw new ToolExecutionError(`${redactAuditString(message, outputStore.knownSecrets)}\n\n${renderCommandReceipt(details, outputStore.knownSecrets)}`, details, error);
			}
			const preflightDurationMs = Math.round((performance.now() - preflightStarted) * 100) / 100;
			const observer = commandSandboxMode === "read-only" ? undefined : options.observer;
			const checkpointStarted = performance.now();
			let checkpointCount = 0;
			try {
				if (observer?.beforeWorkspace) { await observer.beforeWorkspace(); checkpointCount++; }
			} catch (error) {
				const details = {
					argv,
					cwd: resolved.relativePath,
					resultKind: "failure" satisfies CommandResultKind,
					mutationRisk: "none" satisfies CommandMutationRisk,
					executionOutcome: "rejected-before-start",
					capturedBytes: 0,
					previewTruncated: false,
					omittedBytes: 0,
					outputComplete: false,
					preflightDurationMs,
					checkpointDurationMs: Math.round((performance.now() - checkpointStarted) * 100) / 100,
					subprocessDurationMs: 0,
					renderingDurationMs: 0,
					checkpointCount,
				};
				throw new ToolExecutionError(`Command checkpoint capture failed before start\n\n${renderCommandReceipt(details, outputStore.knownSecrets)}`, details, error);
			}
			let checkpointDurationMs = performance.now() - checkpointStarted;
			let result;
			let changedPaths: string[] | void = undefined;
			let executionError: unknown;
			const subprocessStarted = performance.now();
			try { result = await runSandboxedProcess(() => runBoundedProcess(resolveCodexBinary(options.codexBinary), invocation, resolved.target, timeoutSeconds, outputStore, toolCallId, options.sandboxPath, signal), signal); }
			catch (error) { executionError = error; }
			const subprocessDurationMs = Math.round((performance.now() - subprocessStarted) * 100) / 100;
			const afterCheckpointStarted = performance.now();
			try {
				if (observer?.afterWorkspace) { changedPaths = await observer.afterWorkspace(); checkpointCount++; }
			}
			catch (error) {
				if (executionError instanceof ToolExecutionError) executionError.details.rewindCoverage = "incomplete";
				if (!executionError) executionError = new ToolExecutionError("Command settled but checkpoint capture failed", { ...result?.receipt, processStarted: result?.processStarted, exitCode: result?.exitCode, rewindCoverage: "incomplete" }, error);
			}
			checkpointDurationMs = Math.round((checkpointDurationMs + performance.now() - afterCheckpointStarted) * 100) / 100;
			if (executionError) {
				const error = executionError instanceof ToolExecutionError ? executionError : new ToolExecutionError(executionError instanceof Error ? executionError.message : String(executionError), {}, executionError);
				const processStarted = error.details.processStarted === true;
				const mutationRisk: CommandMutationRisk = commandSandboxMode === "read-only" || !processStarted ? "none" : "possible";
				// An interrupted command (timeout, abort) may have stopped mid-write, so it keeps unknown effects
				// and gets no continuation route, unless the complete workspace capture found no changed file.
				const interruptedWithoutChanges = processStarted && commandSandboxMode === "workspace" && Array.isArray(changedPaths) && changedPaths.length === 0
					&& observer?.workspaceCaptureComplete?.() === true;
				const executionOutcome = !processStarted ? "rejected-before-start" : mutationRisk === "none" || interruptedWithoutChanges ? "known" : "effects-unknown";
				const details = {
					...error.details,
					argv,
					cwd: resolved.relativePath,
					resultKind: "failure" satisfies CommandResultKind,
					mutationRisk,
					executionOutcome,
					// With known effects, recovery routes (retrying required validation after a fresh read) apply as
					// they do to a command that settled on its own; they key on the confining sandbox.
					...(interruptedWithoutChanges ? {
						changedPaths: changedPaths ?? [],
						sandbox: "codex-native",
						filesystem: commandSandboxMode,
						network: "disabled",
					} : {}),
					preflightDurationMs,
					checkpointDurationMs,
					subprocessDurationMs,
					renderingDurationMs: 0,
					checkpointCount,
				};
				const message = `${redactAuditString(error.message, outputStore.knownSecrets)}${executionOutcome === "effects-unknown" ? ". Command effects may already have occurred; inspect state before retrying." : ""}${typeof error.details.output === "string" && error.details.output ? `\n${error.details.output}` : ""}\n\n${renderCommandReceipt(details, outputStore.knownSecrets)}`;
				throw new ToolExecutionError(message, details, error);
			}
			if (!result) throw new Error("Command result missing");
			const renderingStarted = performance.now();
			const resultKind: CommandResultKind = result.exitCode === 0 ? "success" : "failure";
			const mutationRisk: CommandMutationRisk = commandSandboxMode === "read-only" ? "none" : "possible";
			// A process that exited on its own inside the write-confined sandbox, whose
			// complete before/after workspace capture found no changed file, has known
			// effects: a failing test run should not lock out the edits that fix it.
			const settledWithoutChanges = commandSandboxMode === "workspace" && Array.isArray(changedPaths) && changedPaths.length === 0
				&& observer?.workspaceCaptureComplete?.() === true && result.receipt.outputComplete === true;
			const executionOutcome = resultKind === "success" || mutationRisk === "none" || settledWithoutChanges ? "known" : "effects-unknown";
			const renderingDurationMs = Math.round((performance.now() - renderingStarted) * 100) / 100;
			const details = {
				argv,
				cwd: resolved.relativePath,
				exitCode: result.exitCode,
				resultKind,
				mutationRisk,
				executionOutcome,
				...result.receipt,
				changedPaths: changedPaths ?? [],
				sandbox: "codex-native",
				filesystem: commandSandboxMode,
				network: commandSandboxMode === "full-access" ? "enabled" : "disabled",
				rewindCoverage: commandSandboxMode === "read-only" ? "not-required" : observer ? observer.coverage?.() ?? "captured" : "incomplete",
				preflightDurationMs,
				checkpointDurationMs,
				subprocessDurationMs,
				renderingDurationMs,
				checkpointCount,
			};
			return {
				content: [{ type: "text", text: result.receipt.output }, { type: "text", text: renderCommandReceipt(details, outputStore.knownSecrets) }],
				details,
			};
		},
	};
}

const primaryBashLeaf = (operation: BashOperation): BashLeafOperation => operation.kind === "compound"
	? operation.parts[0]!.operation
	: operation;

const singleBashSearch = (operation: BashOperation): Extract<BashLeafOperation, { kind: "search" }> | undefined => {
	const leaf = operation.kind === "compound" && operation.parts.length === 1 && operation.operators.length === 0 && operation.parts[0]?.headLines === undefined
		? operation.parts[0]!.operation
		: operation.kind === "compound" ? undefined : operation;
	return leaf?.kind === "search" ? leaf : undefined;
};

const operationToolId = (operation: BashOperation): string => primaryBashLeaf(operation).kind === "pwd"
	? "bash.pwd"
	: bashPermissionTarget(operation).toolId;

export const createNativeBashArgv = (command: string): string[] => [resolveBashExecutable(), "--noprofile", "--norc", "-c", command];

const textContent = (result: { content: Array<{ type: string; text?: string }> }): string => result.content[0]?.type === "text"
	? result.content[0].text ?? ""
	: "";

const BASH_FILESYSTEM_ROOT_ARGUMENT = /(?:^|[\s;&|])(?:["']\/["']|\/|["'][A-Za-z]:[\\/]["']|[A-Za-z]:[\\/])(?=$|[\s;&|])/u;

export function readToolOutputTool(outputStore: CommandOutputStore): AgentTool<typeof readToolOutputParameters> {
	return {
		name: "read_tool_output",
		label: "Read saved tool output",
		description: toolCacheDefinitions.read_tool_output.description,
		parameters: readToolOutputParameters,
		executionMode: "sequential",
		async execute(_toolCallId, { outputId, offset = 0, limit = TOOL_OUTPUT_READ_LIMIT_BYTES, pattern, contextLines = 2 }, signal) {
			throwIfAborted(signal);
			if (pattern !== undefined) {
				const found = await outputStore.search(outputId, pattern, contextLines, signal);
				const notice = found.matches
					? `[${found.matches} matching line${found.matches === 1 ? "" : "s"} for ${JSON.stringify(pattern)} in ${found.totalBytes} saved bytes${found.truncated ? "; results truncated, narrow the pattern or reduce contextLines" : ""}.]`
					: `[No lines match ${JSON.stringify(pattern)} in ${found.totalBytes} saved bytes.]`;
				return { content: [{ type: "text", text: found.text ? `${found.text}

${notice}` : notice }], details: found };
			}
			const range = await outputStore.read(outputId, offset, limit, signal);
			const end = range.nextOffset ?? range.totalBytes;
			const notice = range.nextOffset === undefined
				? `[End of ${range.complete ? "complete" : "incomplete"} saved output at byte ${end} of ${range.totalBytes}.]`
				: `[Saved output bytes ${range.offset}-${end - 1} of ${range.totalBytes}. Continue with read_tool_output({"outputId":"${range.outputId}","offset":${range.nextOffset},"limit":${TOOL_OUTPUT_READ_LIMIT_BYTES}}).]`;
			return { content: [{ type: "text", text: `${range.text}\n\n${notice}` }], details: range };
		},
	};
}

export function bashTool(
	workspaceRoot: string,
	options: RunOwnedCommandOptions & { allowReadOnlyFallback?: boolean; allowedCanonicalToolIds?: readonly string[]; nativeOperationId?: "inspect_workspace" | "run_workspace_command"; planner?: BashCommandPlanner },
): AgentTool<typeof bashParameters> {
	const allowedCanonicalToolIds = options.allowedCanonicalToolIds ? new Set(options.allowedCanonicalToolIds) : undefined;
	const planner = options.planner;
	return {
		name: "bash",
		label: "Bash workspace facade",
		description: toolCacheDefinitions.bash.description,
		parameters: bashParameters,
		executionMode: "sequential",
		async execute(toolCallId, args: BashToolArguments, signal) {
			const argv = createNativeBashArgv(args.command);
			let plan: BashCommandPlan;
			try { plan = planner?.consume(toolCallId, args) ?? planBashCommand(args, workspaceRoot); }
			catch (error) {
				const details = { argv, cwd: args.cwd ?? ".", command: args.command, resultKind: "failure", mutationRisk: "none", executionOutcome: "rejected-before-start", parseStatus: "unplanned" };
				throw new ToolExecutionError(`${redactAuditString(error instanceof Error ? error.message : String(error), options.outputStore.knownSecrets)}\n\n${renderCommandReceipt(details, options.outputStore.knownSecrets)}`, details, error);
			}
			const configuredMode = options.commandSandboxMode ?? "workspace";
			const trustedExecution = plan.route === "semantic-native" && bashPlanUsesTrustedExecution(plan, workspaceRoot);
			const trustedRead = plan.route === "semantic-native" && plan.readOnly && trustedExecution && bashPlanUsesReadOnlySandbox(plan, workspaceRoot);
			const readOnlyFallback = configuredMode === "read-only" && options.allowReadOnlyFallback === true;
			const readOnly = configuredMode === "read-only" || configuredMode !== "full-access" && trustedRead;
			const semanticOperationId = plan.route === "semantic-native" ? operationToolId(plan.operation) : "run_workspace_command";
			const operationId = plan.route === "semantic-native" && plan.readOnly && options.nativeOperationId !== "run_workspace_command"
				? semanticOperationId
				: readOnlyFallback ? "inspect_workspace" : "run_workspace_command";
			const provenance = {
				argv,
				cwd: args.cwd ?? ".",
				command: args.command,
				operationId,
				bashKind: "native",
				shell: argv[0],
				parseStatus: plan.route,
				planReason: plan.reason,
				readOnly,
			};
			try {
				if (plan.readOnly && !trustedRead) throw new ToolExecutionError("Trusted Bash executable changed after permission planning", {
					resultKind: "failure", mutationRisk: "none", executionOutcome: "rejected-before-start",
				});
				const requiredToolIds = new Set([
					...(operationId === "bash.pwd" ? [] : [operationId]),
					...(trustedRead && plan.route === "semantic-native" ? bashPermissionTargets(plan.operation).map(({ toolId }) => toolId) : []),
				]);
				const unavailable = allowedCanonicalToolIds && [...requiredToolIds].find((toolId) => !allowedCanonicalToolIds.has(toolId));
				if (unavailable) throw new ToolExecutionError(`bash operation is unavailable in this tool profile: ${unavailable}`, {
					resultKind: "failure", mutationRisk: "none", executionOutcome: "rejected-before-start",
				});
				if (configuredMode !== "full-access" && plan.reason === "workspace-escape") throw new ToolExecutionError("bash path escapes the workspace", {
					resultKind: "failure", mutationRisk: "none", executionOutcome: "rejected-before-start",
				});
				if (configuredMode !== "full-access" && BASH_FILESYSTEM_ROOT_ARGUMENT.test(args.command)) throw new ToolExecutionError("bash filesystem-root paths are unavailable in workspace mode; use a workspace-relative path", {
					resultKind: "failure", mutationRisk: "none", executionOutcome: "rejected-before-start",
				});
				const executionArgv = trustedExecution && plan.route === "semantic-native" && plan.trustedShell
					? [plan.trustedShell, ...argv.slice(1)]
					: argv;
				const shell = runWorkspaceCommandTool(workspaceRoot, {
					...options,
					commandSandboxMode: readOnly ? "read-only" : configuredMode,
					allowArgumentLineBreaks: true,
					...(trustedExecution && plan.route === "semantic-native"
						? { sandboxPath: dirname(plan.trustedExecutable === "<bash-builtin>" ? plan.trustedShell! : plan.trustedExecutable!) }
						: {}),
				});
				const cwd = trustedExecution && plan.route === "semantic-native" && plan.trustedCwd
					? relative(realpathSync.native(workspaceRoot), plan.trustedCwd) || "."
					: args.cwd ?? ".";
				const result = await shell.execute(toolCallId, { argv: executionArgv, cwd, timeoutSeconds: args.timeoutSeconds ?? 120 }, signal);
				const details = result.details && typeof result.details === "object" ? result.details as Record<string, unknown> : {};
				const search = plan.route === "semantic-native" ? singleBashSearch(plan.operation) : undefined;
				const noMatches = trustedExecution && Boolean(search && search.maxCount !== 0) && details.exitCode === 1;
				const resultKind: CommandResultKind = noMatches ? "no-matches" : details.resultKind === "success" ? "success" : "failure";
				const output = textContent(result);
				const evidenceOperation = plan.route === "semantic-native" && plan.operation.kind === "compound"
					? plan.operation.parts.length === 1 && !plan.operation.operators.length ? plan.operation.parts[0]!.operation : undefined
					: plan.route === "semantic-native" ? plan.operation : undefined;
				const inspectedPaths = trustedRead && evidenceOperation
					? [...new Set(bashPermissionTargets(evidenceOperation).flatMap(({ toolId, arguments: target }) => toolId === "inspect_workspace" && typeof target.path === "string" ? [target.path] : []))]
					: [];
				const finalDetails = {
					...details,
					...provenance,
					resultKind,
					executionOutcome: noMatches ? "known" : details.executionOutcome,
					...(plan.route === "semantic-native" && plan.semanticArgv ? { semanticArgv: plan.semanticArgv } : {}),
					...(trustedRead ? { semanticOperationId } : {}),
					...(inspectedPaths.length ? { paths: inspectedPaths } : {}),
				};
				return {
					content: [
						{ type: "text" as const, text: output },
						{ type: "text" as const, text: renderCommandReceipt(finalDetails, options.outputStore.knownSecrets) },
					],
					details: finalDetails,
				};
			} catch (rawError) {
				const error = rawError instanceof ToolExecutionError
					? rawError
					: new ToolExecutionError(rawError instanceof Error ? rawError.message : String(rawError), {}, rawError);
				const details = { ...error.details, ...provenance };
				const message = redactAuditString(error.message.replace(/\n\n\[Command receipt: [^\n]*\]$/u, ""), options.outputStore.knownSecrets);
				throw new ToolExecutionError(`${message}\n\n${renderCommandReceipt(details, options.outputStore.knownSecrets)}`, details, error);
			}
		},
	};
}
export interface ResolveToolsOptions {
	commandSandboxMode?: CommandSandboxMode;
	bashCommandSandboxMode?: CommandSandboxMode;
	bashNativeOperationId?: "inspect_workspace" | "run_workspace_command";
	bashReadOnlyFallback?: boolean;
	bashAllowedCanonicalToolIds?: readonly string[];
	bashPlanner?: BashCommandPlanner;
	outputStore?: CommandOutputStore;
	privatePaths?: readonly string[];
	/** Tools from the run's modules; created only when listed in ids. */
	moduleTools?: readonly HarnessModuleTool[];
	/** Passed to module tools so they can start child runs that inherit this run. */
	moduleRun?: HarnessModuleRunContext;
	/** Receives usage an approval-gated module tool reported with a thrown ModuleToolError. */
	onModuleToolFailureUsage?: (usage: unknown) => void;
}

export function resolveTools(
	ids: string[],
	workspaceRoot: string,
	observer?: WorkspaceMutationObserver,
	writeScope?: WorkspaceWriteScope,
	options: ResolveToolsOptions = {},
): AgentTool[] {
	if (ids.some((id) => id === "bash" || id === "run_workspace_command" || id === "read_tool_output") && !options.outputStore) {
		throw new Error("Command tools require a run-owned output store");
	}
	const privatePaths = options.privatePaths ?? [];
	const tools: AgentTool[] = ids.map((id) => {
		if (id === "bash") return bashTool(workspaceRoot, { observer, commandSandboxMode: options.bashCommandSandboxMode ?? options.commandSandboxMode, nativeOperationId: options.bashNativeOperationId, allowReadOnlyFallback: options.bashReadOnlyFallback, allowedCanonicalToolIds: options.bashAllowedCanonicalToolIds, planner: options.bashPlanner, outputStore: options.outputStore!, privatePaths });
		if (id === "list_workspace") return listWorkspaceTool(workspaceRoot, privatePaths);
		if (id === "search_workspace") return searchWorkspaceTool(workspaceRoot, privatePaths);
		if (id === "inspect_workspace") return inspectWorkspaceTool(workspaceRoot, privatePaths);
		if (id === "read_tool_output") {
			if (!options.outputStore) throw new Error("read_tool_output requires a run-owned output store");
			return readToolOutputTool(options.outputStore);
		}
		if (id === "write_workspace") return writeWorkspaceTool(workspaceRoot, observer, writeScope, privatePaths);
		if (id === "edit_workspace") return editWorkspaceTool(workspaceRoot, observer, writeScope, privatePaths);
		if (id === "run_workspace_command") return runWorkspaceCommandTool(workspaceRoot, { observer, commandSandboxMode: options.commandSandboxMode, outputStore: options.outputStore!, privatePaths });
		const moduleTool = options.moduleTools?.find(({ definition }) => definition.name === id);
		if (moduleTool) return createModuleTool(moduleTool, { workspaceRoot, privatePaths, ...(options.moduleRun ? { run: options.moduleRun } : {}) }, options.onModuleToolFailureUsage);
		throw new Error(`Unknown tool: ${id}`);
	});
	return tools;
}

/** Every tool name the core owns; modules may not reuse them. */
export const CORE_TOOL_IDS: ReadonlySet<string> = new Set(Object.keys(toolCacheDefinitions));

export function resolveToolCacheDefinitions(ids: string[], moduleTools: readonly HarnessModuleTool[] = []): unknown[] {
	return ids.map((id) => {
		const definition = toolCacheDefinitions[id as keyof typeof toolCacheDefinitions] ?? moduleTools.find((tool) => tool.definition.name === id)?.definition;
		if (!definition) throw new Error(`Unknown tool: ${id}`);
		return definition;
	});
}
