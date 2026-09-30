import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, rmdirSync, unlinkSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const MANIFEST_NAME = "tool-output-manifest.json";
const PRIVATE_MANIFEST_NAME = "manifest.json";
const MAX_INDEX_BYTES = 4 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_CAPTURED_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_CAPTURED_RUN_BYTES = 32 * 1024 * 1024;
const MAX_READABLE_OUTPUT_BYTES = MAX_CAPTURED_OUTPUT_BYTES * 4;
const MAX_READABLE_RUN_BYTES = MAX_CAPTURED_RUN_BYTES * 4;
const OUTPUT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OUTPUT_ROOT = join(realpathSync.native(tmpdir()), ".codetonomy-output");

export interface StoredToolOutput {
	outputId: string;
	originCallId: string;
	fileName: string;
	capturedBytes: number;
	readableBytes: number;
	complete: boolean;
	sha256: string;
	identity: string;
}

export interface StoredToolOutputManifest {
	path: string;
	indexPath: string;
	runId: string;
	workspace: string;
	sessionId?: string;
	identityKind: "mtime";
	outputDirectory: string;
	directoryIdentity: string;
	manifestIdentity: string;
	manifestSha256: string;
	indexIdentity: string;
	indexSha256: string;
	outputs: StoredToolOutput[];
	partials: Array<{ fileName: string; originCallId: string }>;
}

export interface IssuedToolOutput {
	outputId: string;
	originCallId: string;
}

const fileIdentity = (info: ReturnType<typeof fstatSync>): string => `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}`;
const directoryIdentity = (info: NonNullable<ReturnType<typeof lstatSync>>): string => `${info.dev}:${info.ino}`;

const readStandalone = (path: string, maximum: number): { bytes: Buffer; info: Stats } => {
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = fstatSync(descriptor);
		if (!info.isFile() || info.nlink !== 1 || info.size > maximum) throw new Error("Invalid tool-output file");
		const bytes = Buffer.alloc(info.size);
		let length = 0;
		while (length < bytes.length) {
			const read = readSync(descriptor, bytes, length, bytes.length - length, length);
			if (!read) break;
			length += read;
		}
		const after = fstatSync(descriptor);
		if (fileIdentity(info) !== fileIdentity(after) || length !== info.size) throw new Error("Tool-output file changed while reading");
		return { bytes, info };
	} finally { closeSync(descriptor); }
};

const traceDirectory = (tracePath: string): string => {
	const directory = dirname(resolve(tracePath));
	try { return realpathSync.native(directory); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return directory;
		throw error;
	}
};

export const issuedToolOutputs = (events: readonly { type: string; data: Record<string, unknown> }[]): IssuedToolOutput[] => {
	const outputs = new Map<string, string>();
	for (const { type, data } of events) {
		if (type === "tool.output.invalidated" && typeof data.outputId === "string" && typeof data.outputOwner === "string") {
			const owner = outputs.get(data.outputId);
			if (owner && owner !== data.outputOwner) throw new Error("Tool-output invalidation has a conflicting originating call");
			outputs.delete(data.outputId);
			continue;
		}
		if ((type !== "tool.completed" && type !== "tool.failed")
			|| (data.toolId !== "bash" && data.toolId !== "run_workspace_command")
			|| typeof data.outputId !== "string" || typeof data.outputOwner !== "string") continue;
		const owner = outputs.get(data.outputId);
		if (owner && owner !== data.outputOwner) throw new Error("Tool-output reference has conflicting originating calls");
		outputs.set(data.outputId, data.outputOwner);
	}
	return [...outputs].map(([outputId, originCallId]) => ({ outputId, originCallId }));
};

export function loadToolOutputManifest(tracePath: string, runId: string, expectedOutputs?: readonly IssuedToolOutput[]): StoredToolOutputManifest | undefined {
	const indexPath = join(traceDirectory(tracePath), MANIFEST_NAME);
	let indexBytes: Buffer;
	let indexInfo: Stats;
	try { ({ bytes: indexBytes, info: indexInfo } = readStandalone(indexPath, MAX_INDEX_BYTES)); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" && !expectedOutputs?.length) return undefined;
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Tool-output index is missing for issued output references");
		throw error;
	}
	const index = JSON.parse(indexBytes.toString("utf8")) as Record<string, unknown>;
	if (index.version !== 1 || index.runId !== runId || typeof index.manifestPath !== "string" || !isAbsolute(index.manifestPath)
		|| !Number.isSafeInteger(index.manifestBytes) || Number(index.manifestBytes) < 1 || Number(index.manifestBytes) > MAX_MANIFEST_BYTES
		|| typeof index.manifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(index.manifestSha256)) throw new Error("Invalid tool-output index");
	const path = resolve(index.manifestPath);
	const outputDirectory = dirname(path);
	const prefix = `.codetonomy-output-${runId}-`;
	if (basename(path) !== PRIVATE_MANIFEST_NAME || dirname(outputDirectory) !== OUTPUT_ROOT
		|| !basename(outputDirectory).startsWith(prefix) || !OUTPUT_ID.test(basename(outputDirectory).slice(prefix.length))) throw new Error("Invalid tool-output ownership");
	const { bytes, info: manifestInfo } = readStandalone(path, MAX_MANIFEST_BYTES);
	if (bytes.length !== index.manifestBytes || createHash("sha256").update(bytes).digest("hex") !== index.manifestSha256) throw new Error("Tool-output manifest changed after publication");
	const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
	if (value.identityKind !== "mtime") throw new Error("Unsupported tool-output manifest identity");
	if (value.version !== 1 || value.runId !== runId || typeof value.workspace !== "string" || !isAbsolute(value.workspace)
		|| (value.sessionId !== undefined && (typeof value.sessionId !== "string" || !value.sessionId || value.sessionId.length > 1024))
		|| typeof value.outputDirectory !== "string" || typeof value.directoryIdentity !== "string"
		|| !Array.isArray(value.outputs) || value.outputs.length > 2_048 || !Array.isArray(value.partials) || value.partials.length > 2_048) throw new Error("Invalid tool-output manifest");
	if (!isAbsolute(value.outputDirectory) || resolve(value.outputDirectory) !== outputDirectory) throw new Error("Invalid tool-output ownership");
	const directory = lstatSync(outputDirectory);
	if (!directory.isDirectory() || directory.isSymbolicLink() || realpathSync.native(outputDirectory) !== outputDirectory || directoryIdentity(directory) !== value.directoryIdentity) throw new Error("Invalid tool-output directory");
	const outputs = value.outputs.map((item) => {
		if (!item || typeof item !== "object") throw new Error("Invalid tool-output entry");
		const entry = item as Record<string, unknown>;
		if (typeof entry.outputId !== "string" || !OUTPUT_ID.test(entry.outputId) || entry.fileName !== `${entry.outputId}.output`
			|| typeof entry.originCallId !== "string" || !/^[0-9a-f]{64}$/.test(entry.originCallId) || entry.allowedReader !== "read_tool_output" || !Number.isSafeInteger(entry.capturedBytes) || Number(entry.capturedBytes) < 0 || Number(entry.capturedBytes) > MAX_CAPTURED_OUTPUT_BYTES
			|| !Number.isSafeInteger(entry.readableBytes) || Number(entry.readableBytes) < 0 || Number(entry.readableBytes) > MAX_READABLE_OUTPUT_BYTES
			|| typeof entry.complete !== "boolean" || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)
			|| typeof entry.identity !== "string") throw new Error("Invalid tool-output entry");
		return entry as unknown as StoredToolOutput;
	});
	if (new Set(outputs.map(({ outputId }) => outputId)).size !== outputs.length) throw new Error("Duplicate tool-output entry");
	if (expectedOutputs) {
		const expected = new Map(expectedOutputs.map(({ outputId, originCallId }) => [outputId, originCallId]));
		if (expected.size !== expectedOutputs.length || expectedOutputs.some(({ outputId, originCallId }) => !OUTPUT_ID.test(outputId) || !originCallId)
			|| outputs.length !== expected.size || outputs.some(({ outputId, originCallId }) => expected.get(outputId) !== originCallId)) {
			throw new Error("Tool-output manifest does not exactly match issued output references");
		}
	}
	if (outputs.reduce((total, entry) => total + entry.capturedBytes, 0) > MAX_CAPTURED_RUN_BYTES
		|| outputs.reduce((total, entry) => total + entry.readableBytes, 0) > MAX_READABLE_RUN_BYTES) throw new Error("Tool-output manifest exceeds run quotas");
	const partials = value.partials.map((item) => {
		if (!item || typeof item !== "object") throw new Error("Invalid tool-output partial");
		const partial = item as Record<string, unknown>;
		if (typeof partial.fileName !== "string" || !partial.fileName.endsWith(".partial") || !OUTPUT_ID.test(partial.fileName.slice(0, -".partial".length)) || basename(partial.fileName) !== partial.fileName || typeof partial.originCallId !== "string" || !/^[0-9a-f]{64}$/.test(partial.originCallId)) throw new Error("Invalid tool-output partial");
		return partial as unknown as { fileName: string; originCallId: string };
	});
	if (new Set(partials.map(({ fileName }) => fileName)).size !== partials.length) throw new Error("Duplicate tool-output partial");
	return {
		path,
		indexPath,
		runId,
		workspace: value.workspace,
		...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
		identityKind: "mtime",
		outputDirectory,
		directoryIdentity: value.directoryIdentity,
		manifestIdentity: fileIdentity(manifestInfo),
		manifestSha256: createHash("sha256").update(bytes).digest("hex"),
		indexIdentity: fileIdentity(indexInfo!),
		indexSha256: createHash("sha256").update(indexBytes).digest("hex"),
		outputs,
		partials,
	};
}

export function readStoredToolOutput(manifest: StoredToolOutputManifest, entry: StoredToolOutput): Buffer {
	const path = join(manifest.outputDirectory, entry.fileName);
	const { bytes, info } = readStandalone(path, MAX_READABLE_OUTPUT_BYTES);
	if (fileIdentity(info) !== entry.identity || bytes.length !== entry.readableBytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error("Stored tool output changed");
	return bytes;
}

const validatePartial = (manifest: StoredToolOutputManifest, fileName: string): void => {
	const path = join(manifest.outputDirectory, fileName);
	try {
		const info = lstatSync(path);
		if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_CAPTURED_OUTPUT_BYTES) throw new Error("Invalid tool-output partial");
	} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
};

export function validateStoredToolOutput(tracePath: string, runId: string, expectedOutputs?: readonly IssuedToolOutput[]): StoredToolOutputManifest | undefined {
	const manifest = loadToolOutputManifest(tracePath, runId, expectedOutputs);
	if (!manifest) return undefined;
	for (const entry of manifest.outputs) readStoredToolOutput(manifest, entry);
	for (const partial of manifest.partials) validatePartial(manifest, partial.fileName);
	return manifest;
}

export function pruneStoredToolOutput(tracePath: string, runId: string, validated?: StoredToolOutputManifest): void {
	const manifest = validated ?? validateStoredToolOutput(tracePath, runId);
	if (!manifest) return;
	const indexPath = join(traceDirectory(tracePath), MANIFEST_NAME);
	const prefix = `.codetonomy-output-${runId}-`;
	if (manifest.runId !== runId || manifest.indexPath !== indexPath || manifest.path !== join(manifest.outputDirectory, PRIVATE_MANIFEST_NAME)
		|| manifest.identityKind !== "mtime" || dirname(manifest.outputDirectory) !== OUTPUT_ROOT || !basename(manifest.outputDirectory).startsWith(prefix)
		|| !OUTPUT_ID.test(basename(manifest.outputDirectory).slice(prefix.length))) throw new Error("Invalid tool-output cleanup ownership");
	try {
		const directory = lstatSync(manifest.outputDirectory);
		if (!directory.isDirectory() || directory.isSymbolicLink() || realpathSync.native(manifest.outputDirectory) !== manifest.outputDirectory || directoryIdentity(directory) !== manifest.directoryIdentity) throw new Error("Invalid tool-output cleanup directory");
	} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	for (const entry of manifest.outputs) {
		if (!OUTPUT_ID.test(entry.outputId) || entry.fileName !== `${entry.outputId}.output` || basename(entry.fileName) !== entry.fileName) throw new Error("Invalid tool-output cleanup entry");
		try {
			readStoredToolOutput(manifest, entry);
			unlinkSync(join(manifest.outputDirectory, entry.fileName));
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
	for (const partial of manifest.partials) {
		if (basename(partial.fileName) !== partial.fileName) throw new Error("Invalid tool-output cleanup partial");
		const path = join(manifest.outputDirectory, partial.fileName);
		try {
			validatePartial(manifest, partial.fileName);
			unlinkSync(path);
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
	for (const [path, expectedIdentity, expectedHash, maximum] of [
		[manifest.path, manifest.manifestIdentity, manifest.manifestSha256, MAX_MANIFEST_BYTES],
		[manifest.indexPath, manifest.indexIdentity, manifest.indexSha256, MAX_INDEX_BYTES],
	] as const) try {
		const { bytes, info } = readStandalone(path, maximum);
		if (fileIdentity(info) !== expectedIdentity || createHash("sha256").update(bytes).digest("hex") !== expectedHash) throw new Error("Tool-output cleanup file changed");
		unlinkSync(path);
	} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	try { rmdirSync(manifest.outputDirectory); }
	catch (error) { if (!new Set(["ENOENT", "ENOTEMPTY"]).has((error as NodeJS.ErrnoException).code ?? "")) throw error; }
}
