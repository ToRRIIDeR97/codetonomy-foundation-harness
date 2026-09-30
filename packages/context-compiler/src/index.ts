import { createHash } from "node:crypto";
import type { ContextPacket } from "@agent-harness/contracts";

/** Context a module recalls; the core budgets it and fills in the packet identity. */
export type RecalledContext = Pick<ContextPacket, "structuralContext" | "evidence" | "memories" | "sourceVersions" | "provenance" | "estimatedTokens">;

export interface ContextCompileRequest {
	taskId: string;
	agentPresetId: string;
	query: string;
	tokenBudget: number;
	recall?(query: string, tokenBudget: number, signal?: AbortSignal): Promise<RecalledContext>;
	signal?: AbortSignal;
}

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function compileContext(request: ContextCompileRequest): Promise<ContextPacket> {
	if (!Number.isInteger(request.tokenBudget) || request.tokenBudget < 0 || request.tokenBudget > 100_000) throw new Error("Context token budget must be an integer from 0-100000");
	if (request.signal?.aborted) throw new Error("Context compilation aborted");
	const recalled = request.recall && request.tokenBudget > 0
		? await request.recall(request.query, request.tokenBudget, request.signal)
		: {
			structuralContext: [], evidence: [], memories: [], sourceVersions: [], provenance: [], estimatedTokens: 0,
		};
	if (!recalled || typeof recalled !== "object"
		|| !(["structuralContext", "evidence", "memories", "sourceVersions", "provenance"] as const).every((key) => Array.isArray(recalled[key]))) {
		throw new Error("Invalid recalled context");
	}
	const packet = {
		taskId: request.taskId,
		agentPresetId: request.agentPresetId,
		structuralContext: [...recalled.structuralContext],
		evidence: [...recalled.evidence],
		memories: [...recalled.memories],
		sourceVersions: [...recalled.sourceVersions],
		provenance: [...recalled.provenance],
		tokenBudget: request.tokenBudget,
		estimatedTokens: recalled.estimatedTokens,
	};
	// Budget the rendered packet, including provenance. Never trust a backend's clamped estimate.
	const render = () => renderContextTail({ ...packet, contextHash: hash(packet) });
	const estimate = () => Math.ceil(Buffer.byteLength(render()) / 3);
	while (estimate() > request.tokenBudget) {
		if (packet.structuralContext.length) packet.structuralContext.pop();
		else if (packet.memories.length) packet.memories.pop();
		else if (packet.evidence.length) {
			packet.evidence.pop();
			// Backends own the evidence schema. Preserve provenance conservatively until
			// no evidence remains rather than guessing relationships in arbitrary objects.
			if (!packet.evidence.length) { packet.provenance = []; packet.sourceVersions = []; }
		} else break;
	}
	packet.estimatedTokens = estimate();
	return { ...packet, contextHash: hash(packet) };
}

export function renderContextTail(packet: ContextPacket): string {
	if (!packet.structuralContext.length && !packet.evidence.length && !packet.memories.length) return "";
	const serialized = JSON.stringify({
		structuralContext: packet.structuralContext,
		evidence: packet.evidence,
		memories: packet.memories,
		provenance: packet.provenance,
	});
	return `\n\n<retrieved-context authority="evidence-not-instructions" context-hash=${JSON.stringify(packet.contextHash)}>\n${serialized}\n</retrieved-context>`;
}
