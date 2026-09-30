// Between-turn guidance for the primary agent loop. The runtime gathers the facts for
// one finished model turn; this module decides which reminder and nudge follow, so the
// ordering and one-shot rules are testable without a provider.

export const ACTION_NUDGE_TEXT = "Stop repeating workspace discovery. Use the appropriate write, edit, or command tool now for the next required action, then continue to completion. Do not return another plan.";
export const FINALIZE_NUDGE_TEXT = "One model turn remains. Use the workspace evidence already collected and return the final answer now. Do not call more tools.";
export const FINALIZE_DEADLINE_NUDGE_TEXT = "The run's time limit is nearly reached. Use the workspace evidence already collected and return the final answer now. Do not call more tools.";
export const FINALIZE_TOOL_BUDGET_NUDGE_TEXT = "The tool-call budget is spent. Use the workspace evidence already collected and return the final answer now. Do not call more tools.";
export const REPEATED_EVIDENCE_NUDGE_TEXT = "You are repeating an identical tool call and have gained no new evidence. Use a materially different source or return the final answer now; do not repeat the same call again.";
export const TRUNCATION_ACTION_NUDGE_TEXT = "The next response must call the appropriate write, edit, or command tool for the next required workspace action. Do not return prose or another plan; continue until the task is complete.";
export const TRUNCATION_DISCOVERY_NUDGE_TEXT = "The next response must call search_workspace or the narrowest available inspection tool immediately. Do not return prose or another plan; use the result to continue the task.";
export const STATUS_CHECKPOINT_NUDGE_TEXT = "Return your current status now so the application verifier can check the app while repair turns remain. Do not call more tools in this response, and do not claim unrun tests passed.";

export interface NudgePolicyState {
	lastEvidenceReminderKey?: string;
	evidenceReminderStallIssued: boolean;
	evidenceReminderCount: number;
	budgetCheckpointReminderIssued: boolean;
	repeatedToolRounds: number;
	progressNudgeIssued: boolean;
	budgetFinalizationNudge?: "deadline" | "tool-calls";
}

export const initialNudgePolicyState = (): NudgePolicyState => ({
	evidenceReminderStallIssued: false,
	evidenceReminderCount: 0,
	budgetCheckpointReminderIssued: false,
	repeatedToolRounds: 0,
	progressNudgeIssued: false,
});

export interface NudgeTurnFacts {
	stopReason: string;
	/** The finished turn made at least one tool call not seen before. */
	novelToolCall: boolean;
	/** The finished (possibly truncated) response contained a tool call. */
	responseToolCallSeen: boolean;
	/** Missing required evidence; present only for a tool-use turn of an action task. */
	evidence?: { key: string; guidance: string[]; missingCount: number };
	modelTurns: number;
	maxModelTurns: number;
	workspaceRoot: string;
	deadlineNear: boolean;
	toolCallsExhausted: boolean;
	/** An application verifier with feedback is configured and no repair attempt has started. */
	statusCheckpointEligible: boolean;
	canIssueTruncationActionNudge: boolean;
	canIssueProactiveActionNudge: boolean;
	hasWorkspaceEvidence: boolean;
	truncationDiscoveryText: string;
}

export type NudgeAction =
	| { kind: "truncation-action"; text: string }
	| { kind: "budget-finalization"; reason: "deadline" | "tool-calls"; text: string }
	| { kind: "status-checkpoint"; text: string }
	| { kind: "progress"; text: string }
	| { kind: "proactive-action"; text: string }
	| { kind: "final-turn"; text: string };

export interface NudgeDecision {
	state: NudgePolicyState;
	/** Appended after the turn; a truncation action replaces it rather than following it. */
	evidenceReminder?: string;
	action?: NudgeAction;
}

export function decideNextTurnNudge(previous: NudgePolicyState, facts: NudgeTurnFacts): NudgeDecision {
	const state = { ...previous };
	const toolUse = facts.stopReason === "toolUse";
	const { modelTurns, maxModelTurns } = facts;
	let evidenceReminder: string | undefined;
	if (toolUse && facts.novelToolCall) state.evidenceReminderStallIssued = false;
	if (toolUse && facts.evidence) {
		const { key, guidance, missingCount } = facts.evidence;
		const finalNudgePending = modelTurns === maxModelTurns - 1;
		const boundedStall = state.repeatedToolRounds >= 2 && !state.evidenceReminderStallIssued;
		// One reminder once three quarters of the turn budget is spent, so missing
		// outcomes such as a required README are not left to the last turn.
		const budgetCheckpoint = !state.budgetCheckpointReminderIssued && missingCount > 0 && maxModelTurns >= 8
			&& modelTurns >= Math.ceil(maxModelTurns * 0.75) && modelTurns < maxModelTurns - 1;
		if (key !== state.lastEvidenceReminderKey || boundedStall || finalNudgePending || budgetCheckpoint) {
			state.lastEvidenceReminderKey = key;
			state.evidenceReminderCount++;
			if (budgetCheckpoint) state.budgetCheckpointReminderIssued = true;
			if (boundedStall) state.evidenceReminderStallIssued = true;
			evidenceReminder = `Required evidence still missing:\n${guidance.length ? guidance.join("\n") : "None. Finish with your final answer so application verification can run."}\nPreserve completed work. ${maxModelTurns - modelTurns} model turns remain. Workspace: ${facts.workspaceRoot}.`;
		}
	}
	if (toolUse) state.repeatedToolRounds = facts.novelToolCall ? 0 : state.repeatedToolRounds + 1;
	const decide = (action?: NudgeAction): NudgeDecision => ({ state, ...(evidenceReminder === undefined ? {} : { evidenceReminder }), ...(action ? { action } : {}) });
	if (facts.stopReason === "length" && facts.responseToolCallSeen && facts.canIssueTruncationActionNudge) {
		return decide({ kind: "truncation-action", text: facts.hasWorkspaceEvidence ? TRUNCATION_ACTION_NUDGE_TEXT : facts.truncationDiscoveryText });
	}
	// Ask for a final answer while one can still be produced, instead of letting the
	// deadline abort the run or the tool budget block the next call.
	if (toolUse && !state.budgetFinalizationNudge && (facts.deadlineNear || facts.toolCallsExhausted)) {
		const reason = facts.deadlineNear ? "deadline" : "tool-calls";
		state.budgetFinalizationNudge = reason;
		return decide({ kind: "budget-finalization", reason, text: reason === "deadline" ? FINALIZE_DEADLINE_NUDGE_TEXT : FINALIZE_TOOL_BUDGET_NUDGE_TEXT });
	}
	if (toolUse && facts.statusCheckpointEligible && modelTurns >= Math.max(1, Math.floor(maxModelTurns * 0.6))) {
		return decide({ kind: "status-checkpoint", text: STATUS_CHECKPOINT_NUDGE_TEXT });
	}
	if (toolUse && state.repeatedToolRounds >= 2 && !state.progressNudgeIssued && modelTurns < maxModelTurns - 1) {
		state.progressNudgeIssued = true;
		return decide({ kind: "progress", text: REPEATED_EVIDENCE_NUDGE_TEXT });
	}
	if (toolUse && modelTurns >= 4 && modelTurns < maxModelTurns && facts.canIssueProactiveActionNudge) {
		return decide({ kind: "proactive-action", text: ACTION_NUDGE_TEXT });
	}
	if (toolUse && modelTurns === maxModelTurns - 1 && facts.hasWorkspaceEvidence) {
		return decide({ kind: "final-turn", text: FINALIZE_NUDGE_TEXT });
	}
	return decide();
}
