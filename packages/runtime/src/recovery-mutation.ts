import { randomUUID } from "node:crypto";
import type { RunRecoveryMutation } from "@agent-harness/contracts";

/** Run-local record of a failed tool call awaiting trusted resolution. */
export interface RecoverableToolError {
	toolName: string;
	message: string;
	modelRequestId?: string;
	modelTurn: number;
	key: string;
	recoveryKey: string;
	target?: string;
	obligationId?: string;
	eventId?: string;
	outcome: string;
	schemaRepair?: { toolName: string; arguments: unknown };
	retryCommand?: string[];
	retryCwd?: string;
	optionalDiagnostic?: boolean;
	corrected?: boolean;
	correctionRevisions?: Record<string, string>;
	proposalFingerprint?: string;
	proposalEventId?: string;
	proposalSourceRevision?: string;
	resolved?: boolean;
}

/** Optional fields persisted unchanged between a run and its resumed session. */
type SharedField = keyof RunRecoveryMutation & keyof RecoverableToolError;
const CARRIED_FIELDS = ["target", "retryCommand", "retryCwd", "optionalDiagnostic", "corrected", "correctionRevisions", "obligationId"] as const satisfies readonly SharedField[];

// Every RunRecoveryMutation field must be carried or mapped explicitly below;
// a new contract field fails this check until the round trip handles it.
type UnmappedField = Exclude<keyof RunRecoveryMutation, (typeof CARRIED_FIELDS)[number] | "toolName" | "message" | "outcome" | "failureEventId">;
const allFieldsMapped: [UnmappedField] extends [never] ? true : UnmappedField = true;
void allFieldsMapped;

const copy = <T>(value: T): T => Array.isArray(value) ? [...value] as T : value && typeof value === "object" ? { ...value } : value;

const carried = (source: Partial<Record<(typeof CARRIED_FIELDS)[number], unknown>>) => {
	const fields: Record<string, unknown> = {};
	for (const field of CARRIED_FIELDS) if (source[field] !== undefined) fields[field] = copy(source[field]);
	return fields as Pick<RunRecoveryMutation, (typeof CARRIED_FIELDS)[number]>;
};

/** Seeds a resumed run. modelTurn 0 means only this run's fresh evidence can resolve it. */
export const recoverableErrorFromMutation = (mutation: RunRecoveryMutation): RecoverableToolError => ({
	toolName: mutation.toolName,
	message: mutation.message,
	modelTurn: 0,
	key: "",
	recoveryKey: "",
	outcome: mutation.outcome,
	resolved: false,
	...carried(mutation),
	// Parent later resolutions even when the interrupted run died
	// before its failure event finished writing.
	eventId: mutation.failureEventId ?? randomUUID(),
});

/** Projects an unresolved unknown-effects failure for save/reload. */
export const mutationFromRecoverableError = (failure: RecoverableToolError): RunRecoveryMutation => {
	const { obligationId, ...fields } = carried(failure);
	return {
		toolName: failure.toolName,
		message: failure.message.slice(0, 1_000),
		outcome: "effects-unknown",
		...fields,
		...(failure.eventId !== undefined ? { failureEventId: failure.eventId } : {}),
		...(obligationId !== undefined ? { obligationId } : {}),
	};
};
