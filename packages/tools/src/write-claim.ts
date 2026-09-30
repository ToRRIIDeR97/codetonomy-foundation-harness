// Write scopes for runs that may change only declared paths. The core applies one to every run
// with writePaths; orchestration also checks that concurrent children's claims do not overlap.

import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

export interface WriteClaim {
	workspaceRoot: string;
	paths: string[];
	wholeWorkspace: boolean;
}

const fold = (path: string): string => process.platform === "darwin" || process.platform === "win32" ? path.toLocaleLowerCase() : path;

const within = (root: string, path: string): boolean => {
	const result = relative(fold(root), fold(path));
	return result === "" || (!result.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && result !== ".." && !isAbsolute(result));
};

async function resolveClaimPath(root: string, requestedPath: string): Promise<string> {
	const lexical = resolve(root, requestedPath);
	if (!within(root, lexical)) throw new Error(`Write path is outside the workspace: ${requestedPath}`);
	let current = lexical;
	const tail: string[] = [];
	for (;;) {
		try {
			const info = await lstat(current);
			if (info.isSymbolicLink()) throw new Error(`Write path contains a symbolic link: ${requestedPath}`);
			const ancestor = await realpath(current);
			const target = resolve(ancestor, ...tail);
			if (!within(root, target)) throw new Error(`Write path resolves outside the workspace: ${requestedPath}`);
			return target;
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || !["ENOENT", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code))) throw error;
			const parent = dirname(current);
			if (parent === current) throw new Error(`Cannot resolve write path: ${requestedPath}`);
			tail.unshift(basename(current));
			current = parent;
		}
	}
}

export async function normalizeWriteClaim(
	workspaceRoot: string,
	permissionProfileId: "workspace-read" | "workspace-write",
	writePaths?: string[],
): Promise<WriteClaim> {
	const root = await realpath(workspaceRoot);
	if (permissionProfileId === "workspace-read") {
		if (writePaths?.length) throw new Error("Read-only child cannot declare write paths");
		return { workspaceRoot: root, paths: [], wholeWorkspace: false };
	}
	if (!writePaths?.length) return { workspaceRoot: root, paths: [], wholeWorkspace: true };
	const paths = new Set<string>();
	for (const [index, raw] of writePaths.entries()) {
		const path = raw.trim();
		if (!path) throw new Error(`writePaths[${index}] is required`);
		if (/[*?[\]]/.test(path)) throw new Error(`writePaths[${index}] cannot contain a glob`);
		paths.add(await resolveClaimPath(root, path));
	}
	return { workspaceRoot: root, paths: [...paths].sort(), wholeWorkspace: false };
}

export function writeClaimsOverlap(left: WriteClaim, right: WriteClaim): boolean {
	const leftWrites = left.wholeWorkspace || left.paths.length > 0;
	const rightWrites = right.wholeWorkspace || right.paths.length > 0;
	if (!leftWrites || !rightWrites) return false;
	if (left.wholeWorkspace || right.wholeWorkspace) return within(left.workspaceRoot, right.workspaceRoot) || within(right.workspaceRoot, left.workspaceRoot);
	return left.paths.some((a) => right.paths.some((b) => within(a, b) || within(b, a)));
}
