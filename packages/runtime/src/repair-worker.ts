import { isDeepStrictEqual } from "node:util";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { validateToolArguments, type Context, type Message, type Tool } from "@earendil-works/pi-ai";
import type { CommandMutationRisk, CommandResultKind } from "@agent-harness/tools";

export const REPAIR_WORKER_CONTEXTS = ["compact", "fork"] as const;
export type RepairWorkerContext = (typeof REPAIR_WORKER_CONTEXTS)[number];
export interface RepairWorkerOptions { context: RepairWorkerContext }

export type RepairFailureKind = "schema-validation";
export interface RepairFailureCandidate {
	failureId: string;
	callId: string;
	modelRequestId?: string;
	toolName: string;
	operationFingerprint: string;
	originalArguments: unknown;
	target?: string;
	targetLabel?: string;
	sourceRevision: string;
	kind: RepairFailureKind;
	rejection: string;
	schema: unknown;
	objective: string;
	constraints: Record<string, unknown>;
	acceptanceRule: unknown;
	toolCeiling: string[];
	permissionProfileId: string;
}

export interface RepairEligibility {
	eligible: boolean;
	kind?: RepairFailureKind;
	reason: string;
}

export function classifyRepairFailure(input: {
	knownTool: boolean;
	parseStatus?: string;
	truncated: boolean;
	blocked: boolean;
	cancelled: boolean;
	toolName: string;
	operationId: string;
	executionOutcome: string;
	resultKind?: CommandResultKind;
	mutationRisk?: CommandMutationRisk;
	schemaValid: boolean;
}): RepairEligibility {
	if (!input.knownTool) return { eligible: false, reason: "unknown-tool" };
	if (input.parseStatus === "invalid") return { eligible: false, reason: "malformed-tool-json" };
	if (input.truncated) return { eligible: false, reason: "truncated-provider-output" };
	if (input.cancelled) return { eligible: false, reason: "cancelled" };
	if (input.blocked) return { eligible: false, reason: "permission-or-policy-denial" };
	if ((input.toolName === "bash" || input.operationId === "run_workspace_command")
		&& (input.resultKind !== "failure" || input.mutationRisk !== "none")) {
		return { eligible: false, reason: "native-command-outcome-ineligible" };
	}
	if (input.executionOutcome !== "rejected-before-start") return { eligible: false, reason: "execution-started" };
	if (!input.schemaValid) return { eligible: true, kind: "schema-validation", reason: "schema-validation" };
	return { eligible: false, reason: "semantic-repair-not-supported" };
}

export interface RepairPacket {
	version: 1;
	identity: {
		failureId: string;
		originalCallId: string;
		operationFingerprint: string;
		sourceRevision: string;
		modelRequestId?: string;
	};
	intent: {
		objective: string;
		constraints: Record<string, unknown>;
		acceptanceRule: unknown;
	};
	attempt: {
		toolName: string;
		arguments: unknown;
		rejection: { kind: RepairFailureKind; message: string };
	};
	contract: {
		schema: unknown;
		toolCeiling: string[];
		permissionProfileId: string;
	};
	evidence: Array<{ source: string; revision: string }>;
}

const MAX_PACKET_BYTES = 64 * 1024;
const MAX_PROPOSAL_ARGUMENT_BYTES = 8 * 1024;
const MAX_EXPLANATION_CHARS = 512;
const MAX_RECEIPT_BYTES = 12 * 1024;
const REPAIR_SYSTEM_PROMPT = [
	"You are a private tool-call repair worker.",
	"Return exactly one JSON object and no markdown.",
	"Do not call tools, claim execution, change the tool or target, expand permissions, guess missing values, clamp numbers, or invent units.",
	"Allowed results are {\"kind\":\"propose\",\"failureId\":string,\"toolName\":string,\"arguments\":object,\"explanation\":string}, {\"kind\":\"abstain\",\"failureId\":string,\"reason\":string}, or {\"kind\":\"needs-context\",\"failureId\":string,\"reason\":string}.",
].join("\n");

export function createRepairPacket(candidate: RepairFailureCandidate): RepairPacket {
	const packet: RepairPacket = {
		version: 1,
		identity: {
			failureId: candidate.failureId,
			originalCallId: candidate.callId,
			operationFingerprint: candidate.operationFingerprint,
			sourceRevision: candidate.sourceRevision,
			...(candidate.modelRequestId ? { modelRequestId: candidate.modelRequestId } : {}),
		},
		intent: {
			objective: candidate.objective,
			constraints: candidate.constraints,
			acceptanceRule: candidate.acceptanceRule,
		},
		attempt: {
			toolName: candidate.toolName,
			arguments: candidate.originalArguments,
			rejection: { kind: candidate.kind, message: candidate.rejection },
		},
		contract: {
			schema: candidate.schema,
			toolCeiling: candidate.toolCeiling,
			permissionProfileId: candidate.permissionProfileId,
		},
		evidence: candidate.targetLabel ? [{ source: candidate.targetLabel, revision: candidate.sourceRevision }] : [],
	};
	if (Buffer.byteLength(JSON.stringify(packet)) > MAX_PACKET_BYTES) throw new Error("Repair packet exceeds 64 KiB");
	return packet;
}

const packetPrompt = (packet: RepairPacket): string => `<repair-packet>\n${JSON.stringify(packet)}\n</repair-packet>`;

export function createRepairContext(input: {
	mode: RepairWorkerContext;
	packet: RepairPacket;
	primarySystemPrompt: string;
	primaryMessages: Message[];
	tools: Tool[];
}): { context: Context; cachePrediction: "none" | "logical-shared-prefix" } {
	const prompt = packetPrompt(input.packet);
	return input.mode === "compact"
		? {
			context: { systemPrompt: REPAIR_SYSTEM_PROMPT, messages: [{ role: "user", content: prompt, timestamp: Date.now() }], tools: [] },
			cachePrediction: "none",
		}
		: {
			context: {
				systemPrompt: input.primarySystemPrompt,
				messages: [...input.primaryMessages, { role: "user", content: `${REPAIR_SYSTEM_PROMPT}\n${prompt}`, timestamp: Date.now() }],
				tools: input.tools,
			},
			cachePrediction: "logical-shared-prefix",
		};
}

type ParsedRepairResponse =
	| { kind: "propose"; failureId: string; toolName: string; arguments: Record<string, unknown>; explanation: string }
	| { kind: "abstain" | "needs-context"; failureId: string; reason: string }
	| { kind: "invalid"; reason: string };

const plainObject = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const exactKeys = (value: Record<string, unknown>, expected: string[]): boolean =>
	Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");

export function parseRepairResponse(text: string, failureId: string, toolName: string): ParsedRepairResponse {
	let value: unknown;
	try { value = JSON.parse(text.trim()); }
	catch { return { kind: "invalid", reason: "worker-response-not-json" }; }
	if (!plainObject(value) || typeof value.kind !== "string") return { kind: "invalid", reason: "worker-response-schema" };
	if (value.kind === "propose") {
		if (!exactKeys(value, ["kind", "failureId", "toolName", "arguments", "explanation"])
			|| value.failureId !== failureId || value.toolName !== toolName || !plainObject(value.arguments)
			|| typeof value.explanation !== "string" || !value.explanation.trim() || value.explanation.length > MAX_EXPLANATION_CHARS
			|| Buffer.byteLength(JSON.stringify(value.arguments)) > MAX_PROPOSAL_ARGUMENT_BYTES) {
			return { kind: "invalid", reason: "worker-proposal-schema-or-identity" };
		}
		return value as ParsedRepairResponse;
	}
	if (value.kind === "abstain" || value.kind === "needs-context") {
		if (!exactKeys(value, ["kind", "failureId", "reason"]) || value.failureId !== failureId
			|| typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > MAX_EXPLANATION_CHARS) {
			return { kind: "invalid", reason: "worker-decision-schema-or-identity" };
		}
		return value as ParsedRepairResponse;
	}
	return { kind: "invalid", reason: "worker-response-kind" };
}

export function validateRepairProposal(input: {
	tool: AgentTool;
	callId: string;
	originalArguments: unknown;
	proposedArguments: Record<string, unknown>;
	originalTarget?: string;
	targetOf(arguments_: unknown): string | undefined;
}): { valid: true; arguments: Record<string, unknown> } | { valid: false; reason: string } {
	let validated: unknown;
	try {
		const prepared = input.tool.prepareArguments ? input.tool.prepareArguments(input.proposedArguments) : input.proposedArguments;
		validated = validateToolArguments(input.tool, {
			type: "toolCall",
			id: input.callId,
			name: input.tool.name,
			arguments: prepared as Record<string, unknown>,
		});
	} catch { return { valid: false, reason: "proposal-fails-current-schema" }; }
	if (!plainObject(validated)) return { valid: false, reason: "proposal-arguments-not-object" };
	let serialized: string | undefined;
	try { serialized = JSON.stringify(validated); } catch { /* fall through to rejection */ }
	if (!serialized || Buffer.byteLength(serialized) > MAX_PROPOSAL_ARGUMENT_BYTES) return { valid: false, reason: "prepared-proposal-arguments-too-large" };
	if (input.targetOf(validated) !== input.originalTarget) return { valid: false, reason: "proposal-changes-target" };
	if (!plainObject(input.originalArguments)) return { valid: false, reason: "original-arguments-not-object" };
	const parameters = input.tool.parameters as { properties?: unknown; additionalProperties?: unknown };
	const properties = plainObject(parameters.properties)
		? parameters.properties
		: {};
	for (const [key, original] of Object.entries(input.originalArguments)) {
		if ((Object.hasOwn(validated, key) && !isDeepStrictEqual(validated[key], original))
			|| (!Object.hasOwn(validated, key) && (Object.hasOwn(properties, key) || parameters.additionalProperties !== false))) {
			return { valid: false, reason: "proposal-changes-operation-intent" };
		}
	}
	for (const key of Object.keys(validated)) if (!Object.hasOwn(input.originalArguments, key)) {
		return { valid: false, reason: "proposal-invents-argument" };
	}
	return { valid: true, arguments: validated };
}

export interface RepairReceipt {
	failureId: string;
	callId: string;
	toolName: string;
	arguments: Record<string, unknown>;
	explanation: string;
	text: string;
}

export function createRepairReceipt(input: Omit<RepairReceipt, "text">): RepairReceipt {
	const marker = `<repair-proposal failure-id=${JSON.stringify(input.failureId)} executed="false">`;
	const safeJson = (value: unknown): string => JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
	const text = `${marker}\nWorker explanation: ${safeJson(input.explanation.trim())}\nProposed reissue: ${input.toolName} ${safeJson(input.arguments)}\nThis correction has not executed and must pass the normal validation, permission, sandbox, checkpoint, and verification gates.\n</repair-proposal>`;
	if (Buffer.byteLength(text) > MAX_RECEIPT_BYTES) throw new Error("Repair receipt exceeds 12 KiB");
	return {
		...input,
		text,
	};
}

export function renderRepairReceipts(messages: AgentMessage[], receipts: Iterable<RepairReceipt>): AgentMessage[] {
	const byCall = new Map([...receipts].map((receipt) => [receipt.callId, receipt]));
	return messages.map((message) => {
		if (message.role !== "toolResult" || !message.isError) return message;
		const receipt = byCall.get(message.toolCallId);
		if (!receipt || message.content.some((block) => block.type === "text" && block.text.includes(`<repair-proposal failure-id=${JSON.stringify(receipt.failureId)}`))) return message;
		return { ...message, content: [...message.content, { type: "text", text: receipt.text }] };
	});
}
