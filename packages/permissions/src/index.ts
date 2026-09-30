import type {
	PermissionDecision,
	PermissionProfile,
	ToolPermissionRequest,
} from "@agent-harness/contracts";

export const permissionModes = ["ask", "auto", "full-access"] as const;
export type PermissionMode = (typeof permissionModes)[number];

export function isPermissionMode(value: unknown): value is PermissionMode {
	return typeof value === "string" && (permissionModes as readonly string[]).includes(value);
}

export const permissionProfiles: Record<string, PermissionProfile> = {
	"workspace-read": {
		id: "workspace-read",
		defaultDecision: "DENY",
		toolDecisions: {
			list_workspace: "ALLOW",
			search_workspace: "ALLOW",
			inspect_workspace: "ALLOW",
			read_tool_output: "ALLOW",
		},
	},
	"workspace-write": {
		id: "workspace-write",
		defaultDecision: "DENY",
		toolDecisions: {
			list_workspace: "ALLOW",
			search_workspace: "ALLOW",
			inspect_workspace: "ALLOW",
			read_tool_output: "ALLOW",
			write_workspace: "ASK",
			edit_workspace: "ASK",
			run_workspace_command: "ASK",
		},
	},
	"no-tools": {
		id: "no-tools",
		defaultDecision: "DENY",
		toolDecisions: {},
	},
};

export type ApprovalHandler = (request: ToolPermissionRequest, signal?: AbortSignal) => Promise<boolean>;

export class PermissionGate {
	readonly #profile: PermissionProfile;
	readonly #approve?: ApprovalHandler;
	readonly #moduleToolAccess: ReadonlyMap<string, "read" | "approval">;

	/**
	 * Module tools declare their access: "read" tools are allowed and "approval" tools ask,
	 * under any workspace profile. The "no-tools" profile still denies them.
	 */
	constructor(profile: PermissionProfile, approve?: ApprovalHandler, moduleToolAccess: Iterable<readonly [string, "read" | "approval"]> = []) {
		this.#profile = profile;
		this.#approve = approve;
		this.#moduleToolAccess = new Map(moduleToolAccess);
	}

	decisionFor(toolId: string): PermissionDecision {
		const decision = this.#profile.toolDecisions[toolId];
		if (decision) return decision;
		const access = this.#profile.id === "no-tools" ? undefined : this.#moduleToolAccess.get(toolId);
		return access === "read" ? "ALLOW" : access === "approval" ? "ASK" : this.#profile.defaultDecision;
	}

	async check(request: ToolPermissionRequest, signal?: AbortSignal): Promise<{ allowed: boolean; decision: PermissionDecision; reason: string }> {
		signal?.throwIfAborted();
		const decision = this.decisionFor(request.toolId);
		if (decision === "ALLOW") return { allowed: true, decision, reason: "Allowed by permission profile" };
		if (decision === "DENY") return { allowed: false, decision, reason: "Denied by permission profile" };
		if (!this.#approve) return { allowed: false, decision, reason: "Approval is required but no approval handler is available" };
		let onAbort: (() => void) | undefined;
		let approved: boolean;
		try {
			approved = await Promise.race([
				this.#approve(request, signal),
				new Promise<never>((_, reject) => {
					onAbort = () => reject(signal?.reason ?? new Error("Approval aborted"));
					signal?.addEventListener("abort", onAbort, { once: true });
					if (signal?.aborted) onAbort();
				}),
			]);
			signal?.throwIfAborted();
		} finally {
			if (onAbort) signal?.removeEventListener("abort", onAbort);
		}
		return approved
			? { allowed: true, decision, reason: "Approved by user" }
			: { allowed: false, decision, reason: "Declined by user" };
	}
}

export function getPermissionProfile(id: string): PermissionProfile {
	const profile = permissionProfiles[id];
	if (!profile) throw new Error(`Unknown permission profile: ${id}`);
	return profile;
}
