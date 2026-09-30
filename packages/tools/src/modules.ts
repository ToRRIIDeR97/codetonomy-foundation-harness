// The harness-owned module interface. A module contributes read-only tools, context
// recalled before a run, and a hook after the run. The core never imports a module;
// callers pass modules to the runtime, which validates them before any provider request.

import { extname } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RunResult, RunUsage } from "@agent-harness/contracts";

export interface HarnessModuleToolDefinition {
	name: string;
	version: string;
	description: string;
	/** JSON Schema with type "object"; several gateways reject other roots. */
	parameters: object;
}

/** What a module tool learns about the run that created it. */
export interface HarnessModuleRunContext {
	/** 0 for a top-level run, 1 for a delegated child. */
	depth: number;
	permissionProfileId: string;
	/**
	 * The run options a child run of this run must inherit: provider, limits, shared budget
	 * objects, approval handler, observers and modules. Typed by the runtime as
	 * Partial<HarnessRunOptions>; opaque here because the runtime depends on this package.
	 */
	inheritedOptions: Readonly<Record<string, unknown>>;
}

export interface HarnessModuleTool {
	definition: HarnessModuleToolDefinition;
	/**
	 * "read" tools are allowed under any workspace profile; "approval" tools ask first. An
	 * "approval" tool may report work it ran on the run's behalf in its result `details`:
	 * `changedPaths` (workspace files it changed, credited as the run's writes), `additionalUsage`
	 * (model usage added to the run's usage) and `recoveryScopes` (ids of the units of work the
	 * call attempted; a later successful call whose scopes include every scope of a failed call
	 * resolves that failure). A failing call throws ModuleToolError for its usage and may attach
	 * `details` with `changedPaths` and `recoveryScopes` to that error.
	 */
	access: "read" | "approval";
	/** Default true. False keeps the tool out of delegated child runs, including carried session tools. */
	offerInChildRuns?: boolean;
	/** "inspection" also satisfies the runtime's evidence nudge; "search" only the workspace-evidence check. */
	evidence?: "inspection" | "search";
	/** Default "always". An extension list offers the tool only when a task input matches. */
	offer?: "always" | { inputExtensions: readonly string[] };
	/** Deterministic guidance added to the stable system prompt when the tool is listed. */
	promptLines?(context: { toolIds: ReadonlySet<string>; toolInterface: "structured" | "bash" }): readonly string[];
	create(context: HarnessModuleToolContext): AgentTool;
}

export interface HarnessModuleToolContext {
	workspaceRoot: string;
	privatePaths: readonly string[];
	/** Present when the runtime creates the tool for a run. */
	run?: HarnessModuleRunContext;
}

/** The fields of a ContextPacket a module supplies; the core fills in and budgets the rest. */
export interface RecalledContext {
	structuralContext: unknown[];
	evidence: unknown[];
	memories: unknown[];
	sourceVersions: unknown[];
	provenance: unknown[];
	estimatedTokens: number;
}

export interface HarnessModule {
	id: string;
	/** Keeps data across runs (an index or a memory store); benchmarks refuse these. */
	stateful?: boolean;
	tools?: readonly HarnessModuleTool[];
	recall?(request: { query: string; tokenBudget: number; signal?: AbortSignal }): Promise<RecalledContext>;
	capture?(run: RunResult, signal?: AbortSignal): Promise<void>;
}

const MODULE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const EXTENSION = /^\.[a-z0-9]{1,16}$/;

const invalid = (reason: string): never => { throw new Error(`Invalid module configuration: ${reason}`); };

/** Rejects malformed modules and any tool name the core or another module already owns. */
export function validateModules(modules: unknown, coreToolIds: ReadonlySet<string>): asserts modules is readonly HarnessModule[] {
	if (!Array.isArray(modules)) invalid("modules must be an array");
	const moduleIds = new Set<string>();
	const toolNames = new Set<string>();
	let recallProviders = 0;
	for (const module of modules as unknown[]) {
		const candidate = module as Partial<HarnessModule> | null;
		if (!candidate || typeof candidate !== "object" || typeof candidate.id !== "string" || !MODULE_ID.test(candidate.id)) invalid("module id must match ^[a-z][a-z0-9-]{0,63}$");
		const id = candidate!.id!;
		if (moduleIds.has(id)) invalid(`duplicate module id ${id}`);
		moduleIds.add(id);
		if (candidate!.stateful !== undefined && typeof candidate!.stateful !== "boolean") invalid(`${id}: stateful must be a boolean`);
		for (const hook of ["recall", "capture"] as const) if (candidate![hook] !== undefined && typeof candidate![hook] !== "function") invalid(`${id}: ${hook} must be a function`);
		if (candidate!.recall) recallProviders++;
		if (candidate!.tools !== undefined && !Array.isArray(candidate!.tools)) invalid(`${id}: tools must be an array`);
		for (const tool of candidate!.tools ?? []) {
			const definition = tool?.definition;
			const name = definition?.name;
			if (typeof name !== "string" || !TOOL_NAME.test(name)) invalid(`${id}: tool name must match ^[a-z][a-z0-9_]{0,63}$`);
			if (coreToolIds.has(name!)) invalid(`${id}: ${name} is a core tool`);
			if (toolNames.has(name!)) invalid(`${id}: ${name} is provided by another module`);
			toolNames.add(name!);
			if (typeof definition!.version !== "string" || !definition!.version || typeof definition!.description !== "string" || !definition!.description) invalid(`${id}: ${name} needs a version and description`);
			const parameters = definition!.parameters as { type?: unknown } | undefined;
			if (!parameters || typeof parameters !== "object" || parameters.type !== "object") invalid(`${id}: ${name} parameters must be an object schema`);
			if (tool.access !== "read" && tool.access !== "approval") invalid(`${id}: ${name} access must be "read" or "approval"`);
			if (tool.offerInChildRuns !== undefined && typeof tool.offerInChildRuns !== "boolean") invalid(`${id}: ${name} offerInChildRuns must be a boolean`);
			if (tool.evidence !== undefined && tool.evidence !== "inspection" && tool.evidence !== "search") invalid(`${id}: ${name} has an unknown evidence kind`);
			if (typeof tool.create !== "function") invalid(`${id}: ${name} needs create()`);
			if (tool.promptLines !== undefined && typeof tool.promptLines !== "function") invalid(`${id}: ${name} promptLines must be a function`);
			const offer = tool.offer;
			if (offer !== undefined && offer !== "always" && !(offer && typeof offer === "object" && Array.isArray(offer.inputExtensions)
				&& offer.inputExtensions.length > 0 && offer.inputExtensions.every((extension: unknown) => typeof extension === "string" && EXTENSION.test(extension.toLowerCase())))) {
				invalid(`${id}: ${name} offer must be "always" or { inputExtensions }`);
			}
		}
	}
	if (recallProviders > 1) invalid("at most one module may provide recall");
}

export const moduleTools = (modules: readonly HarnessModule[] = []): HarnessModuleTool[] => modules.flatMap((module) => [...(module.tools ?? [])]);

/** Whether a tool is offered for a task with these input paths. */
export const moduleToolOffered = (tool: HarnessModuleTool, inputPaths: readonly string[]): boolean => {
	if (tool.offer === undefined || tool.offer === "always") return true;
	const extensions = new Set(tool.offer.inputExtensions.map((extension) => extension.toLowerCase()));
	return inputPaths.some((path) => extensions.has(extname(path).toLowerCase()));
};

/**
 * Thrown by an approval-gated module tool that fails after spending model usage on the run's behalf
 * (for example delegated child runs that did not verify). The runtime adds the usage, then the model
 * sees the error as usual. A successful result reports the same through `details.additionalUsage`.
 */
export class ModuleToolError extends Error {
	constructor(message: string, readonly additionalUsage?: RunUsage) {
		super(message);
		this.name = "ModuleToolError";
	}
}

export function createModuleTool(tool: HarnessModuleTool, context: HarnessModuleToolContext, onFailureUsage?: (usage: unknown) => void): AgentTool {
	const created = tool.create(context);
	if (!created || created.name !== tool.definition.name || typeof created.execute !== "function") {
		throw new Error(`Invalid module configuration: ${tool.definition.name} created a tool with a different name`);
	}
	if (tool.access !== "approval" || !onFailureUsage) return created;
	const execute = created.execute.bind(created);
	created.execute = async (...args) => {
		try {
			return await execute(...args);
		} catch (error) {
			// Duck-typed so a module built against another copy of this package is still counted.
			const usage = (error as { additionalUsage?: unknown } | null)?.additionalUsage;
			if (usage !== undefined) onFailureUsage(usage);
			throw error;
		}
	};
	return created;
}
