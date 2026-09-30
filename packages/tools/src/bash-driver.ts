import { accessSync, constants, existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";

const CHAIN_OPERATORS = new Set([";", "&&", "||"] as const);
const SHELL_INTERPRETERS = new Set([
	"bash", "sh", "zsh", "fish", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "wsl", "wsl.exe",
]);
const SHELL_WRAPPERS = new Set(["busybox", "command", "env", "nohup", "timeout"]);
const PROTECTED_READ_DIRECTORIES = new Set([".agents", ".codex", ".codetonomy", ".git", ".harness", ".pnpm-store", "node_modules"]);
const STRUCTURED_WALK_IGNORED_DIRECTORIES = new Set([...PROTECTED_READ_DIRECTORIES, ".reference-repos", "dist"]);
const MAX_NATIVE_SEARCH_ENTRIES = 100_000;

export interface BashToolArguments {
	command: string;
	cwd?: string;
	timeoutSeconds?: number;
}

export type BashLeafOperation =
	| { kind: "pwd"; cwd: string }
	| { kind: "list"; path: string; paths?: string[]; long: boolean; all: boolean }
	| { kind: "files"; path: string; paths?: string[]; globs?: string[] }
	| {
		kind: "search";
		query: string;
		path: string;
		paths?: string[];
		exact: boolean;
		ignoreCase: boolean;
		filesWithMatches?: boolean;
		globs?: string[];
		heading?: boolean;
		maxCount?: number;
		wordRegexp?: boolean;
	}
	| { kind: "read"; mode: "cat" | "head" | "sed"; path: string; paths?: string[]; offset: number; limit: number }
	| { kind: "command"; argv: string[]; cwd: string; timeoutSeconds: number };

export interface BashCompoundPart {
	operation: BashLeafOperation;
	suppressStderr: boolean;
	headLines?: number;
}

export interface BashCompoundOperation {
	kind: "compound";
	parts: BashCompoundPart[];
	operators: Array<";" | "&&" | "||">;
}

export type BashOperation = BashLeafOperation | BashCompoundOperation;

export interface BashPermissionTarget {
	toolId: "list_workspace" | "search_workspace" | "inspect_workspace" | "run_workspace_command";
	arguments: Record<string, unknown>;
}

export type BashPlanRoute = "semantic-native" | "parse-fallback";
export type BashPlanReason =
	| "external-command"
	| "regular-expression"
	| "ripgrep-semantics"
	| "shell-output"
	| "workspace-escape"
	| "unsupported-option"
	| "path-glob"
	| "mixed-command-chain"
	| "unsupported-operator"
	| "redirect"
	| "shell-expansion"
	| "parser-rejected";
type BashNativeReason = "external-command" | "regular-expression" | "ripgrep-semantics" | "shell-output";
type BashParseFallbackReason = Exclude<BashPlanReason, BashNativeReason>;

export type BashCommandPlan =
	| { route: "semantic-native"; reason: BashNativeReason; operation: BashOperation; readOnly: boolean; semanticArgv?: string[]; trustedCwd?: string; trustedCwdRequest?: string; trustedExecutable?: string; trustedExecutableIdentity?: string; trustedShell?: string; trustedShellIdentity?: string }
	| { route: "parse-fallback"; reason: BashParseFallbackReason; readOnly: false };

interface BashWord {
	kind: "word";
	value: string;
	unquotedGlob: boolean;
	unquotedTilde?: boolean;
}

interface BashOperator {
	kind: "operator";
	value: "|" | ";" | "&&" | "||" | "stderr-null";
}

type BashToken = BashWord | BashOperator;

const tokenize = (command: string): BashToken[] => {
	const tokens: BashToken[] = [];
	let value = "";
	let started = false;
	let unquotedGlob = false;
	let unquotedTilde = false;
	let quote: "single" | "double" | undefined;
	const pushWord = () => {
		if (!started) return;
		tokens.push({ kind: "word", value, unquotedGlob, ...(unquotedTilde ? { unquotedTilde: true } : {}) });
		value = "";
		started = false;
		unquotedGlob = false;
		unquotedTilde = false;
	};
	const pushOperator = (operator: BashOperator["value"]) => {
		pushWord();
		tokens.push({ kind: "operator", value: operator });
	};

	for (let index = 0; index < command.length; index++) {
		const character = command[index]!;
		if (character === "\0" || character === "\r" || character === "\n") throw new Error("bash command cannot contain control line breaks");
		if (quote === "single") {
			if (character === "'") quote = undefined;
			else value += character;
			continue;
		}
		if (quote === "double") {
			if (character === '"') quote = undefined;
			else if (character === "\\") {
				const next = command[++index];
				if (next === undefined) throw new Error("bash command ends with an escape");
				if (next === "\r" || next === "\n") throw new Error("bash command cannot contain control line breaks");
				value += ["$", "`", '"', "\\"].includes(next) ? next : `\\${next}`;
			} else {
				if (character === "$" || character === "`") throw new Error("bash expansion and command substitution are not supported");
				value += character;
			}
			continue;
		}
		if (character === " " || character === "\t") {
			pushWord();
			continue;
		}
		if (/\s/u.test(character)) throw new Error("bash command contains unsupported whitespace");
		if (character === "'") {
			quote = "single";
			started = true;
			continue;
		}
		if (character === '"') {
			quote = "double";
			started = true;
			continue;
		}
		if (character === "\\") {
			const next = command[++index];
			if (next === undefined) throw new Error("bash command ends with an escape");
			if (next === "\r" || next === "\n") throw new Error("bash command cannot contain control line breaks");
			value += next;
			started = true;
			continue;
		}
		if (command.startsWith("2>/dev/null", index) && (index === 0 || /[\s;&|]/u.test(command[index - 1]!)) && /(?:\s|[;&|]|$)/u.test(command[index + 11] ?? "")) {
			pushOperator("stderr-null");
			index += 10;
			continue;
		}
		if (character === "|" && command[index + 1] === "|") {
			pushOperator("||");
			index++;
			continue;
		}
		if (character === "&" && command[index + 1] === "&") {
			pushOperator("&&");
			index++;
			continue;
		}
		if (character === "|") {
			pushOperator("|");
			continue;
		}
		if (character === ";") {
			pushOperator(";");
			continue;
		}
		if (character === "&") throw new Error("bash background commands are not supported");
		if (character === "<" || character === ">") throw new Error("bash redirects are not supported except 2>/dev/null");
		if (character === "(" || character === ")" || character === "{" || character === "}") throw new Error("bash grouping and shell expansion are not supported");
		if (character === "$" || character === "`") throw new Error("bash expansion and command substitution are not supported");
		if (character === "#") throw new Error("bash comments are not supported");
		if (character === "~" && !started) unquotedTilde = true;
		if (character === "*" || character === "?" || character === "[") unquotedGlob = true;
		value += character;
		started = true;
	}
	if (quote) throw new Error("bash command has an unterminated quote");
	pushWord();
	if (!tokens.length) throw new Error("bash command cannot be empty");
	if (tokens.length > 128 || tokens.some((token) => token.kind === "word" && token.value.length > 4_096)) throw new Error("bash command exceeds the plan limits");
	return tokens;
};

const words = (tokens: BashToken[]): BashWord[] => {
	if (tokens.some((token) => token.kind !== "word")) throw new Error("bash contains an unsupported operator");
	return tokens as BashWord[];
};

const normalizeWorkspacePath = (value: string, label: string): string => {
	if (!value) throw new Error(`${label} cannot be empty`);
	if (value.includes("\\")) throw new Error(`${label} must use forward slashes`);
	const workspaceRelative = value === "/workspace" ? "." : value.startsWith("/workspace/") ? value.slice("/workspace/".length) : value;
	if (workspaceRelative.startsWith("/") || /^[A-Za-z]:/.test(workspaceRelative) || workspaceRelative.startsWith("//")) throw new Error(`${label} must be workspace-relative or start with /workspace`);
	const parts: string[] = [];
	for (const part of workspaceRelative.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (!parts.length) throw new Error(`${label} escapes the workspace`);
			parts.pop();
		} else parts.push(part);
	}
	return parts.join("/") || ".";
};

const fromCwd = (cwd: string, path = "."): string => {
	if (path === "/workspace" || path.startsWith("/workspace/")) return normalizeWorkspacePath(path, "bash path");
	if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.startsWith("//")) return normalizeWorkspacePath(path, "bash path");
	return normalizeWorkspacePath(path === "." ? cwd : `${cwd}/${path}`, "bash path");
};

const parsePositiveInteger = (value: string | undefined, label: string, maximum: number): number => {
	if (!value || !/^\d+$/.test(value)) throw new Error(`${label} requires a positive integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${label} must be 1-${maximum}`);
	return parsed;
};

const parseNonnegativeInteger = (value: string | undefined, label: string, maximum: number): number => {
	if (!value || !/^\d+$/.test(value)) throw new Error(`${label} requires a nonnegative integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) throw new Error(`${label} must be 0-${maximum}`);
	return parsed;
};

const normalizedPaths = (values: BashWord[], cwd: string, label: string): string[] => values.map((word) => {
	if (word.unquotedGlob) throw new Error(`${label} path globs are not supported; use rg -g for file filtering`);
	if (word.value === "-") throw new Error(`${label} does not support the stdin sentinel; use ./- for a file named -`);
	return fromCwd(cwd, word.value);
});

const withAdditionalPaths = <const T extends { path: string }>(operation: T, paths: string[]): T & { paths?: string[] } => paths.length > 1
	? { ...operation, paths }
	: operation;

const parseList = (tokens: BashWord[], cwd: string): BashLeafOperation => {
	let long = false;
	let all = false;
	let positional = false;
	const pathWords: BashWord[] = [];
	for (const token of tokens.slice(1)) {
		if (!positional && pathWords.length && token.value.startsWith("-")) throw new Error("bash ls options must precede paths");
		if (!positional && token.value === "--") {
			positional = true;
			continue;
		}
		if (!positional && token.value.startsWith("-")) {
			if (token.value === "--all") all = true;
			else if (/^-[al1]+$/.test(token.value)) {
				long ||= token.value.includes("l");
				all ||= token.value.includes("a");
			} else throw new Error(`bash ls option is not supported: ${token.value}`);
			continue;
		}
		pathWords.push(token);
	}
	const paths = normalizedPaths(pathWords.length ? pathWords : [{ kind: "word", value: ".", unquotedGlob: false }], cwd, "bash ls");
	return withAdditionalPaths({ kind: "list", path: paths[0]!, long, all }, paths);
};

const parseSearch = (tokens: BashWord[], cwd: string): BashLeafOperation => {
	let exact = false;
	let ignoreCase = false;
	let smartCase = false;
	let filesMode = false;
	let filesWithMatches = false;
	let heading = false;
	let maxCount: number | undefined;
	let wordRegexp = false;
	let positional = false;
	let explicitQuery: BashWord | undefined;
	const setQuery = (query: BashWord): void => {
		if (explicitQuery) throw new Error("bash rg option is not supported: repeated patterns");
		explicitQuery = query;
	};
	const values: BashWord[] = [];
	const globs: string[] = [];
	for (let index = 1; index < tokens.length; index++) {
		const token = tokens[index]!;
		const nextValue = (label: string): BashWord => {
			const next = tokens[++index];
			if (!next) throw new Error(`${label} requires a value`);
			return next;
		};
		if (!positional && token.value === "--") {
			positional = true;
			continue;
		}
		if (!positional && token.value.startsWith("-")) {
			if (token.value === "--fixed-strings") exact = true;
			else if (token.value === "--ignore-case") ignoreCase = true;
			else if (token.value === "--smart-case") smartCase = true;
			else if (token.value === "--line-number" || token.value === "--no-heading" || token.value === "--hidden" || token.value === "--no-messages") { /* Deterministic output already has these properties. */ }
			else if (token.value === "--heading") heading = true;
			else if (token.value === "--files-with-matches") filesWithMatches = true;
			else if (token.value === "--word-regexp") wordRegexp = true;
			else if (token.value === "--files") filesMode = true;
			else if (token.value === "--glob") globs.push(nextValue("bash rg --glob").value);
			else if (token.value.startsWith("--glob=")) globs.push(token.value.slice("--glob=".length));
			else if (token.value === "--max-count") maxCount = parseNonnegativeInteger(nextValue("bash rg --max-count").value, "bash rg --max-count", 500);
			else if (token.value.startsWith("--max-count=")) maxCount = parseNonnegativeInteger(token.value.slice("--max-count=".length), "bash rg --max-count", 500);
			else if (token.value === "--regexp") setQuery(nextValue("bash rg --regexp"));
			else if (token.value.startsWith("--regexp=")) setQuery({ ...token, value: token.value.slice("--regexp=".length) });
			else if (token.value === "--color=never") { /* Output never contains terminal color. */ }
			else if (token.value === "-g") globs.push(nextValue("bash rg -g").value);
			else if (token.value.startsWith("-g") && token.value.length > 2) globs.push(token.value.slice(2));
			else if (token.value === "-m") maxCount = parseNonnegativeInteger(nextValue("bash rg -m").value, "bash rg -m", 500);
			else if (/^-m\d+$/.test(token.value)) maxCount = parseNonnegativeInteger(token.value.slice(2), "bash rg -m", 500);
			else if (token.value === "-e") setQuery(nextValue("bash rg -e"));
			else if (token.value.startsWith("-e") && token.value.length > 2) setQuery({ ...token, value: token.value.slice(2) });
			else if (/^-[niFlsw]+$/.test(token.value)) {
				exact ||= token.value.includes("F");
				ignoreCase ||= token.value.includes("i");
				filesWithMatches ||= token.value.includes("l");
				smartCase ||= token.value.includes("S");
				wordRegexp ||= token.value.includes("w");
			} else throw new Error(`bash rg option is not supported: ${token.value}`);
			continue;
		}
		values.push(token);
	}
	if (globs.some((glob) => !glob || glob.includes("\\") || glob.includes("\0"))) throw new Error("bash rg globs must be non-empty forward-slash patterns");
	if (filesMode) {
		if (explicitQuery) throw new Error("bash rg --files does not accept a query");
		const paths = normalizedPaths(values.length ? values : [{ kind: "word", value: ".", unquotedGlob: false }], cwd, "bash rg");
		return withAdditionalPaths({ kind: "files", path: paths[0]!, ...(globs.length ? { globs } : {}) }, paths);
	}
	const queryWord = explicitQuery ?? values.shift();
	if (!queryWord?.value) throw new Error("bash rg requires a query");
	const paths = normalizedPaths(values.length ? values : [{ kind: "word", value: ".", unquotedGlob: false }], cwd, "bash rg");
	if (smartCase && !/[A-Z]/u.test(queryWord.value)) ignoreCase = true;
	return withAdditionalPaths({
		kind: "search",
		query: queryWord.value,
		path: paths[0]!,
		exact,
		ignoreCase,
		...(filesWithMatches ? { filesWithMatches: true } : {}),
		...(globs.length ? { globs } : {}),
		...(heading ? { heading: true } : {}),
		...(maxCount === undefined ? {} : { maxCount }),
		...(wordRegexp ? { wordRegexp: true } : {}),
	}, paths);
};

const parseRead = (tokens: BashWord[], cwd: string): BashLeafOperation => {
	if (tokens[0]!.value === "cat") {
		let positional = false;
		const fileWords: BashWord[] = [];
		for (const token of tokens.slice(1)) {
			if (!positional && fileWords.length && token.value.startsWith("-")) throw new Error("bash cat options must precede files");
			if (!positional && token.value === "--") {
				positional = true;
				continue;
			}
			if (!positional && token.value.startsWith("-")) throw new Error(`bash cat option is not supported: ${token.value}`);
			fileWords.push(token);
		}
		if (!fileWords.length) throw new Error("bash cat requires at least one file");
		const paths = normalizedPaths(fileWords, cwd, "bash cat");
		return withAdditionalPaths({ kind: "read", mode: "cat", path: paths[0]!, offset: 1, limit: 2_000 }, paths);
	}
	if (tokens[0]!.value === "head") {
		let limit = 10;
		let file: BashWord | undefined;
		let positional = false;
		for (let index = 1; index < tokens.length; index++) {
			const token = tokens[index]!;
			if (file) throw new Error("bash head accepts one file and options must precede it");
			if (!positional && token.value === "--") positional = true;
			else if (!positional && (token.value === "-n" || token.value === "--lines")) limit = parsePositiveInteger(tokens[++index]?.value, "bash head", 2_000);
			else if (!positional && /^-\d+$/.test(token.value)) limit = parsePositiveInteger(token.value.slice(1), "bash head", 2_000);
			else if (!positional && token.value.startsWith("--lines=")) limit = parsePositiveInteger(token.value.slice("--lines=".length), "bash head", 2_000);
			else if (!positional && token.value.startsWith("-")) throw new Error(`bash head option is not supported: ${token.value}`);
			else if (file) throw new Error("bash head accepts one file");
			else file = token;
		}
		if (!file) throw new Error("bash head requires a file unless it follows a pipe");
		const path = normalizedPaths([file], cwd, "bash head")[0]!;
		return { kind: "read", mode: "head", path, offset: 1, limit };
	}
	if (tokens.length !== 4 || tokens[1]!.value !== "-n") throw new Error("bash sed supports only: sed -n '<start>,<end>p' <file>");
	if (tokens[3]!.value.startsWith("-")) throw new Error("bash sed file must not look like an option; use ./ for dash-prefixed files");
	const range = tokens[2]!.value.match(/^(\d+)(?:,(\d+))?p$/);
	if (!range) throw new Error("bash sed range must be '<start>,<end>p'");
	const offset = Number(range[1]);
	const end = Number(range[2] ?? range[1]);
	if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset < 1 || end < offset || end - offset + 1 > 2_000) {
		throw new Error("bash sed range must select 1-2000 lines");
	}
	const path = normalizedPaths([tokens[3]!], cwd, "bash sed")[0]!;
	return { kind: "read", mode: "sed", path, offset, limit: end - offset + 1 };
};

const parseLeaf = (tokens: BashWord[], cwd: string, timeoutSeconds: number): BashLeafOperation => {
	if (!tokens.length) throw new Error("bash command segment cannot be empty");
	if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!.value)) throw new Error("bash environment assignments are not supported");
	const executable = tokens[0]!.value.split(/[\\/]/).at(-1)!.toLowerCase();
	if (SHELL_INTERPRETERS.has(executable)) throw new Error("bash cannot invoke another shell interpreter");
	if (SHELL_WRAPPERS.has(executable) && tokens.slice(1).some((token) => SHELL_INTERPRETERS.has(token.value.split(/[\\/]/).at(-1)!.toLowerCase()))) {
		throw new Error("bash cannot invoke a shell interpreter through a command wrapper");
	}
	switch (tokens[0]!.value) {
		case "pwd":
			if (tokens.length !== 1) throw new Error("bash pwd does not accept arguments");
			return { kind: "pwd", cwd };
		case "ls": return parseList(tokens, cwd);
		case "rg": return parseSearch(tokens, cwd);
		case "cat":
		case "head":
		case "sed": return parseRead(tokens, cwd);
		default:
			if (tokens.some((token) => token.unquotedGlob)) throw new Error("bash globs are supported only by recognized rg operations");
			if (tokens.length > 64) throw new Error("bash external command exceeds the 64-argument limit");
			return { kind: "command", argv: tokens.map(({ value }) => value), cwd, timeoutSeconds };
	}
};

const parseHeadPipeline = (tokens: BashToken[]): number => {
	const pipelineWords = words(tokens);
	if (pipelineWords[0]?.value !== "head") throw new Error("bash pipelines support only a final bounded head stage");
	if (pipelineWords.length === 1) return 10;
	if (pipelineWords.length === 2 && /^-\d+$/.test(pipelineWords[1]!.value)) return parsePositiveInteger(pipelineWords[1]!.value.slice(1), "bash head", 2_000);
	if (pipelineWords.length === 3 && ["-n", "--lines"].includes(pipelineWords[1]!.value)) return parsePositiveInteger(pipelineWords[2]!.value, "bash head", 2_000);
	if (pipelineWords.length === 2 && pipelineWords[1]!.value.startsWith("--lines=")) return parsePositiveInteger(pipelineWords[1]!.value.slice("--lines=".length), "bash head", 2_000);
	throw new Error("bash pipeline head supports head, head -N, or head -n N");
};

const parsePart = (tokens: BashToken[], cwd: string, timeoutSeconds: number): BashCompoundPart => {
	const pipes = tokens.flatMap((token, index) => token.kind === "operator" && token.value === "|" ? [index] : []);
	if (pipes.length > 1) throw new Error("bash supports one bounded head pipeline stage");
	const pipeIndex = pipes[0];
	const sourceTokens = pipeIndex === undefined ? [...tokens] : tokens.slice(0, pipeIndex);
	const pipelineTokens = pipeIndex === undefined ? [] : tokens.slice(pipeIndex + 1);
	let suppressStderr = false;
	for (let index = sourceTokens.length - 1; index >= 0; index--) {
		const token = sourceTokens[index]!;
		if (token.kind === "operator" && token.value === "stderr-null") {
			if (index !== sourceTokens.length - 1 || suppressStderr) throw new Error("bash supports 2>/dev/null only at the end of a command segment");
			suppressStderr = true;
			sourceTokens.splice(index, 1);
		}
	}
	const operation = parseLeaf(words(sourceTokens), cwd, timeoutSeconds);
	const headLines = pipeIndex === undefined ? undefined : parseHeadPipeline(pipelineTokens);
	if ((suppressStderr || headLines !== undefined) && operation.kind === "command") throw new Error("bash redirects and pipelines are limited to recognized read-only operations");
	return { operation, suppressStderr, ...(headLines === undefined ? {} : { headLines }) };
};

export function parseBashCommand({ command, cwd = ".", timeoutSeconds = 120 }: BashToolArguments): BashOperation {
	const normalizedCwd = normalizeWorkspacePath(cwd, "bash cwd");
	if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) throw new Error("bash timeoutSeconds must be 1-600");
	const tokens = tokenize(command);
	const parts: BashToken[][] = [[]];
	const operators: BashCompoundOperation["operators"] = [];
	for (const token of tokens) {
		if (token.kind === "operator" && CHAIN_OPERATORS.has(token.value as ";" | "&&" | "||")) {
			if (!parts.at(-1)!.length) throw new Error("bash command chain contains an empty segment");
			operators.push(token.value as ";" | "&&" | "||");
			parts.push([]);
		} else parts.at(-1)!.push(token);
	}
	if (!parts.at(-1)!.length) throw new Error("bash command chain contains an empty segment");
	if (parts.length > 12) throw new Error("bash command chain exceeds 12 segments");
	const parsedParts = parts.map((part) => parsePart(part, normalizedCwd, timeoutSeconds));
	if (parsedParts.length > 1 && parsedParts.some(({ operation }) => operation.kind === "command")) {
		throw new Error("bash command chains are limited to recognized read-only operations");
	}
	const [single] = parsedParts;
	if (single && parsedParts.length === 1 && !single.suppressStderr && single.headLines === undefined) return single.operation;
	return { kind: "compound", parts: parsedParts, operators };
}

const leafPermissionTarget = (operation: BashLeafOperation, path?: string): BashPermissionTarget => {
	switch (operation.kind) {
		case "pwd": return { toolId: "list_workspace", arguments: { path: operation.cwd, depth: 0, limit: 1 } };
		case "list":
		case "files": return { toolId: "list_workspace", arguments: { path: path ?? operation.path } };
		case "search": return {
			toolId: "search_workspace",
			arguments: { query: operation.query, path: path ?? operation.path, caseSensitive: operation.exact && !operation.ignoreCase },
		};
		case "read": return { toolId: "inspect_workspace", arguments: { path: path ?? operation.path, offset: operation.offset, limit: operation.limit } };
		case "command": return { toolId: "run_workspace_command", arguments: { argv: operation.argv, cwd: operation.cwd, timeoutSeconds: operation.timeoutSeconds } };
	}
};

const leafPermissionTargets = (operation: BashLeafOperation): BashPermissionTarget[] => "paths" in operation && operation.paths
	? operation.paths.map((path) => leafPermissionTarget(operation, path))
	: [leafPermissionTarget(operation)];

export function bashPermissionTargets(operation: BashOperation): BashPermissionTarget[] {
	return operation.kind === "compound"
		? operation.parts.flatMap(({ operation: leaf }) => leafPermissionTargets(leaf))
		: leafPermissionTargets(operation);
}

export function bashPermissionTarget(operation: BashOperation): BashPermissionTarget {
	return bashPermissionTargets(operation)[0]!;
}

const BASH_REGEXP_SYNTAX = /[\\^$.*+?()[\]{}|]/;

const nativeReason = (operation: BashOperation): BashNativeReason => {
	if (operation.kind === "compound") return "shell-output";
	if (operation.kind === "command") return "external-command";
	if (operation.kind === "search" && !operation.exact && BASH_REGEXP_SYNTAX.test(operation.query)) return "regular-expression";
	// The workspace walker does not implement rg ignore rules, flags, or output formatting.
	if (operation.kind === "search" || operation.kind === "files") return "ripgrep-semantics";
	// Native byte/newline/path behavior is the contract; structured excerpts are not shell stdout.
	return "shell-output";
};

const OPAQUE_COMMAND_WRAPPERS = new Set([
	"!", ".", "builtin", "command", "doas", "env", "eval", "exec", "find", "git", "git.exe", "nice", "node", "node.exe", "nohup", "perl", "python", "python.exe", "python3", "ruby", "source", "stdbuf", "sudo", "time", "timeout", "xargs",
	...SHELL_INTERPRETERS,
]);

export const bashOperationHasPreciseCommand = (operation: BashOperation): boolean => operation.kind === "command"
	&& !OPAQUE_COMMAND_WRAPPERS.has(operation.argv[0]!.split(/[\\/]/).at(-1)!.toLowerCase());

const parseFallbackReason = (error: unknown): BashParseFallbackReason => {
	const message = error instanceof Error ? error.message : String(error);
	if (/escapes the workspace|must be workspace-relative/u.test(message)) return "workspace-escape";
	if (/option is not supported/u.test(message)) return "unsupported-option";
	if (/path globs|globs are supported only/u.test(message)) return "path-glob";
	if (/command chains are limited/u.test(message)) return "mixed-command-chain";
	if (/unsupported operator|pipelines support only/u.test(message)) return "unsupported-operator";
	if (/redirect/u.test(message)) return "redirect";
	if (/expansion|substitution/u.test(message)) return "shell-expansion";
	return "parser-rejected";
};

const nativeReadExecutable = (operation: BashOperation): string | undefined => {
	if (operation.kind === "compound") return operation.parts.length === 1 && operation.operators.length === 0 && operation.parts[0]?.headLines === undefined
		? nativeReadExecutable(operation.parts[0]!.operation)
		: undefined;
	if (operation.kind === "command") return undefined;
	if (operation.kind === "pwd") return "<bash-builtin>";
	if (operation.kind === "search" || operation.kind === "files") return "rg";
	if (operation.kind === "list") return "ls";
	return operation.mode;
};

const inside = (root: string, path: string): boolean => {
	const candidate = relative(root, path);
	return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate));
};

// The pinned macOS platform defaults independently allow reads and writes here.
// A managed read/deny entry cannot subtract those native policy allowances.
export const sandboxPlatformDefaultsOverlap = (path: string): boolean => {
	if (process.platform !== "darwin") return false;
	const candidates = new Set([resolve(path)]);
	try { candidates.add(realpathSync.native(path)); } catch {}
	return [...candidates].some((candidate) => ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"]
		.some((scratch) => inside(scratch, candidate) || inside(candidate, scratch)));
};

const protectedReadPath = (path: string): boolean => path.split(/[\\/]/).some((part) => PROTECTED_READ_DIRECTORIES.has(part.toLowerCase()));

const canonicalReadPathIsSafe = (workspace: string, path: string): boolean => {
	const unresolved = resolve(workspace, path);
	if (!inside(workspace, unresolved)) return false;
	let ancestor = unresolved;
	while (!existsSync(ancestor)) {
		const parent = dirname(ancestor);
		if (parent === ancestor) return false;
		ancestor = parent;
	}
	try {
		const canonical = resolve(realpathSync.native(ancestor), relative(ancestor, unresolved));
		if (!inside(workspace, canonical) || protectedReadPath(relative(workspace, canonical))) return false;
		if (existsSync(unresolved)) {
			const info = statSync(canonical);
			if (info.isFile() && info.nlink !== 1) return false;
		}
		return true;
	} catch { return false; }
};

const nativeSearchTreeIsSafe = (workspace: string, path: string): boolean => {
	const unresolved = resolve(workspace, path);
	if (!existsSync(unresolved)) return true;
	try {
		const root = realpathSync.native(unresolved);
		const rootInfo = statSync(root);
		if (rootInfo.isFile()) return rootInfo.nlink === 1;
		if (!rootInfo.isDirectory()) return false;
		const pending = [root];
		let entries = 0;
		while (pending.length) {
			const directory = pending.pop()!;
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				if (++entries > MAX_NATIVE_SEARCH_ENTRIES) return false;
				if (entry.isSymbolicLink()) return false;
				// rg skips hidden entries unless --hidden is present; that flag is not eligible below.
				if (entry.name.startsWith(".")) {
					if ([".gitignore", ".ignore", ".rgignore"].includes(entry.name)) {
						const info = lstatSync(join(directory, entry.name));
						if (!info.isFile() || info.nlink !== 1) return false;
					}
					continue;
				}
				if (STRUCTURED_WALK_IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) return false;
				const candidate = join(directory, entry.name);
				const info = lstatSync(candidate);
				if (info.isDirectory()) pending.push(candidate);
				else if (!info.isFile() || info.nlink !== 1) return false;
			}
		}
		return true;
	} catch { return false; }
};

const nativeListPathIsSafe = (workspace: string, path: string): boolean => {
	const unresolved = resolve(workspace, path);
	if (!existsSync(unresolved)) return true;
	try {
		const target = lstatSync(unresolved);
		if (target.isSymbolicLink()) return false;
		if (target.isFile()) return target.nlink === 1;
		if (!target.isDirectory()) return true;
		return readdirSync(unresolved, { withFileTypes: true }).every((entry) => entry.name.startsWith(".")
			|| !entry.isSymbolicLink() && !(entry.isDirectory() && STRUCTURED_WALK_IGNORED_DIRECTORIES.has(entry.name.toLowerCase())));
	} catch { return false; }
};

const readOperandsAreSafe = (operation: BashOperation, semanticArgv: readonly string[] | undefined, workspace: string): boolean => {
	const decoratedLeaf = operation.kind === "compound" && operation.parts.length === 1 && operation.operators.length === 0 && operation.parts[0]?.headLines === undefined
		? operation.parts[0]!.operation
		: undefined;
	if (decoratedLeaf) operation = decoratedLeaf;
	if ((!semanticArgv && !decoratedLeaf) || operation.kind === "compound" || operation.kind === "command") return false;
	if (operation.kind === "list" && operation.all) return false;
	const paths = operation.kind === "pwd"
		? [operation.cwd]
		: "paths" in operation && operation.paths ? operation.paths : [operation.path];
	if (paths.some((path) => protectedReadPath(path) || !canonicalReadPathIsSafe(workspace, path))) return false;
	if (operation.kind === "read" && paths.some((path) => {
		const target = resolve(workspace, path);
		if (!existsSync(target)) return false;
		try { const info = statSync(realpathSync.native(target)); return !info.isFile() || info.nlink !== 1; }
		catch { return true; }
	})) return false;
	if (operation.kind === "list" && paths.some((path) => !nativeListPathIsSafe(workspace, path))) return false;
	if ((operation.kind === "search" || operation.kind === "files") && (operation.globs?.length || paths.some((path) => !nativeSearchTreeIsSafe(workspace, path)))) return false;
	return !semanticArgv?.includes("--hidden");
};

const trustedReadRoots = (): string[] => [...new Set([
	"/bin",
	"/usr/bin",
	"/usr/sbin",
	...(process.platform === "darwin" ? ["/System", "/Applications/ChatGPT.app/Contents/Resources", "/Applications/Codex.app/Contents/Resources"] : []),
	...(process.platform === "win32" ? [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.SystemRoot] : []),
	process.env.CODETONOMY_WORKER_ROOT,
].filter((path): path is string => typeof path === "string" && isAbsolute(path)).flatMap((path) => {
	try { return [realpathSync.native(path)]; }
	catch { return []; }
}))];

const hasTrustedProvenance = (path: string): boolean => trustedReadRoots().some((root) => inside(root, path));

const resolveTrustedExecutable = (name: string, workspaceRoot: string, commandCwd: string): string | undefined => {
	if (name === "<bash-builtin>") return name;
	const lexicalWorkspace = resolve(workspaceRoot);
	const lexicalTemporary = resolve(tmpdir());
	let workspace: string;
	let temporary: string;
	try { workspace = realpathSync.native(workspaceRoot); }
	catch { return undefined; }
	try { temporary = realpathSync.native(tmpdir()); }
	catch { return undefined; }
	const suffixes = process.platform === "win32"
		? [...new Set(["", ...(process.env.PATHEXT ?? ".EXE").split(";").map((suffix) => suffix.toLowerCase())])]
		: [""];
	// On Windows the host PATH often lacks Git Bash's usr/bin and bin, where bash itself finds
	// commands such as ls. Search them only after PATH, so any untrusted PATH match still declines.
	const bashRoot = process.platform === "win32" ? bashInstallationRoot() : undefined;
	const directories = [...(process.env.PATH ?? "").split(delimiter), ...(bashRoot ? [join(bashRoot, "usr", "bin"), join(bashRoot, "bin")] : [])];
	for (const directory of directories) {
		if (directory.split(/[\\/]/).includes("..")) return undefined;
		const base = !directory ? commandCwd : isAbsolute(directory) ? directory : resolve(commandCwd, directory);
		for (const suffix of suffixes) try {
			const unresolved = resolve(base, `${name}${suffix}`);
			if (!existsSync(unresolved)) continue;
			const lexicalBase = resolve(base);
			if (inside(lexicalWorkspace, lexicalBase) || inside(workspace, lexicalBase) || inside(lexicalTemporary, lexicalBase) || inside(temporary, lexicalBase)) return undefined;
			const canonicalBase = realpathSync.native(lexicalBase);
			if (inside(workspace, canonicalBase) || inside(temporary, canonicalBase) || !hasTrustedProvenance(canonicalBase)) return undefined;
			const candidate = realpathSync.native(unresolved);
			if (!statSync(candidate).isFile()) continue;
			accessSync(candidate, constants.X_OK);
			if (inside(workspace, candidate) || inside(temporary, candidate) || !hasTrustedProvenance(candidate)) return undefined;
			return candidate;
		} catch {}
	}
	return undefined;
};

export const resolveBashExecutable = (): string => {
	const explicit = process.env.CODETONOMY_BASH_BIN;
	if (explicit) return explicit;
	if (process.platform !== "win32") {
		const configured = process.env.SHELL;
		if (configured && /^bash(?:\.exe)?$/i.test(basename(configured))) return configured;
		return ["/bin/bash", "/usr/bin/bash"].find(existsSync) ?? "bash";
	}
	const programFiles = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter((value): value is string => Boolean(value));
	const pathCandidates = (process.env.PATH ?? "").split(delimiter)
		.map((directory) => directory.trim().replace(/^"|"$/g, ""))
		.filter(Boolean)
		.map((directory) => join(directory, "bash.exe"));
	return [
		...programFiles.flatMap((directory) => [join(directory, "Git", "bin", "bash.exe"), join(directory, "Git", "usr", "bin", "bash.exe")]),
		...pathCandidates,
	].find(existsSync) ?? "bash";
};

/** Installation root of a standard-layout Git Bash (for example C:\Program Files\Git), if any. */
export const bashInstallationRoot = (executable = resolveBashExecutable()): string | undefined => {
	if (!isAbsolute(executable)) return undefined;
	const directory = dirname(executable);
	if (basename(directory).toLowerCase() !== "bin") return undefined;
	return basename(dirname(directory)).toLowerCase() === "usr" ? dirname(dirname(directory)) : dirname(directory);
};

const trustedShell = (workspaceRoot: string, commandCwd: string): string | undefined => {
	const executable = resolveBashExecutable();
	if (!isAbsolute(executable) && (/[\\/]/.test(executable) || /^[A-Za-z]:/.test(executable))) return undefined;
	return isAbsolute(executable) ? resolveTrustedExecutablePath(executable, workspaceRoot) : resolveTrustedExecutable(executable, workspaceRoot, commandCwd);
};

const trustedIdentity = (path: string | undefined): string | undefined => {
	if (!path) return undefined;
	if (path === "<bash-builtin>") return path;
	try {
		const info = statSync(path);
		return `${info.dev}:${info.ino}:${info.ctimeMs}:${info.size}`;
	} catch { return undefined; }
};

function resolveTrustedExecutablePath(path: string, workspaceRoot: string): string | undefined {
	try {
		if (path.split(/[\\/]/).includes("..")) return undefined;
		const lexicalWorkspace = resolve(workspaceRoot);
		const lexicalTemporary = resolve(tmpdir());
		const workspace = realpathSync.native(workspaceRoot);
		const temporary = realpathSync.native(tmpdir());
		const unresolved = resolve(path);
		const lexicalParent = dirname(unresolved);
		if (inside(lexicalWorkspace, lexicalParent) || inside(workspace, lexicalParent) || inside(lexicalTemporary, lexicalParent) || inside(temporary, lexicalParent)) return undefined;
		const unresolvedParent = realpathSync.native(dirname(unresolved));
		if (inside(workspace, unresolvedParent) || inside(temporary, unresolvedParent) || !hasTrustedProvenance(unresolvedParent)) return undefined;
		const candidate = realpathSync.native(unresolved);
		if (inside(workspace, candidate) || inside(temporary, candidate) || !statSync(candidate).isFile() || !hasTrustedProvenance(candidate)) return undefined;
		accessSync(candidate, constants.X_OK);
		return candidate;
	} catch { return undefined; }
}

export const bashPlanUsesTrustedExecution = (plan: BashCommandPlan, workspaceRoot: string): boolean => {
	if (plan.route !== "semantic-native") return false;
	const executable = nativeReadExecutable(plan.operation);
	let commandCwd: string;
	// An unresolvable workspace root never qualifies for trusted execution.
	try { realpathSync.native(workspaceRoot); }
	catch { return false; }
	try { commandCwd = realpathSync.native(plan.trustedCwdRequest ?? ""); }
	catch { return false; }
	const resolvedExecutable = executable ? resolveTrustedExecutable(executable, workspaceRoot, commandCwd) : undefined;
	const resolvedShell = trustedShell(workspaceRoot, commandCwd);
	return Boolean(commandCwd === plan.trustedCwd && resolve(plan.trustedCwdRequest ?? "") === plan.trustedCwdRequest && resolvedExecutable && resolvedShell
		&& plan.trustedExecutable === resolvedExecutable
		&& plan.trustedExecutableIdentity === trustedIdentity(resolvedExecutable)
		&& plan.trustedShell === resolvedShell
		&& plan.trustedShellIdentity === trustedIdentity(resolvedShell));
};

export const bashPlanUsesReadOnlySandbox = (plan: BashCommandPlan, workspaceRoot: string): boolean => {
	if (!plan.readOnly || sandboxPlatformDefaultsOverlap(workspaceRoot) || !bashPlanUsesTrustedExecution(plan, workspaceRoot) || plan.route !== "semantic-native") return false;
	try { return readOperandsAreSafe(plan.operation, plan.semanticArgv, realpathSync.native(workspaceRoot)); }
	catch { return false; }
};

export const planBashCommand = (args: BashToolArguments, workspaceRoot = process.cwd()): BashCommandPlan => {
	try {
		const operation = parseBashCommand(args);
		const nativeTokens = tokenize(args.command);
		const hasUnquotedExpansion = nativeTokens.some((token) => token.kind === "word" && (token.unquotedGlob || token.unquotedTilde));
		const hasVirtualWorkspacePath = nativeTokens.some((token) => token.kind === "word" && (token.value === "/workspace" || token.value.startsWith("/workspace/")));
		const hasParentTraversal = (args.cwd ?? ".").split(/[\\/]/).includes("..")
			|| nativeTokens.some((token) => token.kind === "word" && token.value.split(/[\\/]/).includes(".."));
		const semanticArgv = !hasUnquotedExpansion && nativeTokens.every((token) => token.kind === "word") ? (nativeTokens as BashWord[]).map(({ value }) => value) : undefined;
		const reason = nativeReason(operation);
		const workspace = realpathSync.native(workspaceRoot);
		const trustedCwdRequest = resolve(workspace, normalizeWorkspacePath(args.cwd ?? ".", "bash cwd"));
		const commandCwd = realpathSync.native(trustedCwdRequest);
		if (!inside(workspace, commandCwd)) throw new Error("bash cwd escapes the workspace");
		const executable = nativeReadExecutable(operation);
		const trustedExecutable = executable ? resolveTrustedExecutable(executable, workspaceRoot, commandCwd) : undefined;
		const shell = trustedShell(workspaceRoot, commandCwd);
		const trustedExecutableIdentity = trustedIdentity(trustedExecutable);
		const trustedShellIdentity = trustedIdentity(shell);
		return {
			route: "semantic-native", reason, operation, readOnly: Boolean(!sandboxPlatformDefaultsOverlap(workspace) && readOperandsAreSafe(operation, semanticArgv, workspace) && !hasUnquotedExpansion && !hasVirtualWorkspacePath && !hasParentTraversal && trustedExecutableIdentity && trustedShellIdentity),
			...(semanticArgv ? { semanticArgv } : {}),
			...(trustedExecutable && trustedExecutableIdentity ? { trustedCwd: commandCwd, trustedCwdRequest, trustedExecutable, trustedExecutableIdentity } : {}),
			...(shell && trustedShellIdentity ? { trustedShell: shell, trustedShellIdentity } : {}),
		};
	} catch (error) {
		return { route: "parse-fallback", reason: parseFallbackReason(error), readOnly: false };
	}
};

const planSignature = ({ command, cwd = ".", timeoutSeconds = 120 }: BashToolArguments): string => JSON.stringify([command, cwd, timeoutSeconds]);

export class BashCommandPlanner {
	readonly #plans = new Map<string, { signature: string; plan: BashCommandPlan }>();
	readonly #workspaceRoot: string;

	constructor(workspaceRoot = process.cwd()) { this.#workspaceRoot = workspaceRoot; }

	plan(toolCallId: string, args: BashToolArguments): BashCommandPlan {
		const signature = planSignature(args);
		const cached = this.#plans.get(toolCallId);
		if (cached?.signature === signature) return cached.plan;
		const plan = planBashCommand(args, this.#workspaceRoot);
		this.#plans.set(toolCallId, { signature, plan });
		if (this.#plans.size > 128) this.#plans.delete(this.#plans.keys().next().value!);
		return plan;
	}

	consume(toolCallId: string, args: BashToolArguments): BashCommandPlan {
		const cached = this.#plans.get(toolCallId);
		if (!cached || cached.signature !== planSignature(args)) throw new Error("Bash execution does not match its permissioned plan");
		this.#plans.delete(toolCallId);
		return cached.plan;
	}

	forget(toolCallId: string): void {
		this.#plans.delete(toolCallId);
	}
}
