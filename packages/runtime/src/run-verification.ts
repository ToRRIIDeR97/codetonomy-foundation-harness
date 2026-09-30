import { relative } from "node:path";
import { redactAuditString, type RunArtifact, type TaskSpecification, type VerificationResult } from "@agent-harness/contracts";
import { inspectWorkspaceTool } from "@agent-harness/tools";
import { verifyOutput, type VerificationEvidence } from "@agent-harness/verifiers";
import type { HarnessApplication } from "./index.js";

export interface RunVerificationInput {
	task: TaskSpecification;
	output: string;
	/** Fatal runtime or output-limit failure recorded during the run. */
	runtimeFailure: string | undefined;
	/** Set when the model-turn budget ran out; replaces the output checks on failure. */
	turnBudgetError: string | undefined;
	evidence: Omit<VerificationEvidence, "task">;
	artifacts: RunArtifact[];
	workspaceRoot: string;
	application: HarnessApplication | undefined;
	knownSecrets: readonly string[];
	signal: AbortSignal | undefined;
}

/** Combines output evidence, artifact, exact-content and application checks for one attempt. */
export async function verifyRunAttempt(input: RunVerificationInput): Promise<VerificationResult> {
	const { task, output, evidence, workspaceRoot, application, signal } = input;
	const outputVerification = verifyOutput(output, input.runtimeFailure, { task, ...evidence });
	const artifactVerification: VerificationResult = { passed: true, checks: [] };
	for (const criterion of task.acceptanceCriteria.filter((item) => item.required && item.expectedContent !== undefined)) {
		let passed = false;
		try {
			const inspected = await inspectWorkspaceTool(workspaceRoot).execute(`verify-${criterion.id}`, { path: relative(workspaceRoot, criterion.target!), offset: 1, limit: 32_001 }, signal);
			passed = !(inspected.details as { truncated?: boolean }).truncated && inspected.content.length === 1 && inspected.content[0]?.type === "text" && inspected.content[0].text === criterion.expectedContent;
		} catch { signal?.throwIfAborted(); }
		artifactVerification.checks.push({ id: `${criterion.id}:content`, passed, message: passed ? `Exact content verified: ${criterion.description}` : `File content does not match: ${criterion.description}` });
	}
	if (application) {
		try {
			const checked = await application.verify({ task, output, artifacts: input.artifacts, workspaceRoot, signal });
			if (!checked.checks.length || checked.passed !== checked.checks.every((check) => check.passed === true)) throw new Error("Application verifier must return nonempty, consistent checks");
			artifactVerification.checks.push(...checked.checks.map((check) => ({ ...check, id: `${application.id}:${check.id}`, message: redactAuditString(check.message, [...input.knownSecrets]).slice(0, 2000) })));
		} catch (error) {
			signal?.throwIfAborted();
			artifactVerification.checks.push({ id: `${application.id}:verifier`, passed: false, message: redactAuditString(error instanceof Error ? error.message : String(error), [...input.knownSecrets]).slice(0, 2000) });
		}
	}
	artifactVerification.passed = artifactVerification.checks.every((check) => check.passed);
	const verification: VerificationResult = {
		passed: outputVerification.passed && artifactVerification.passed,
		checks: [...outputVerification.checks, ...artifactVerification.checks],
		outcomeChecks: artifactVerification.checks.length,
	};
	// An unrecovered length stop is already in runtimeFailure. A truncation the
	// model recovered from is not the cause of a later check failure, so it gets repair.
	if (input.turnBudgetError && !verification.passed) {
		const budgetVerification = verifyOutput(output, input.turnBudgetError, { task, ...evidence });
		return { ...verification, passed: false, checks: [...budgetVerification.checks, ...artifactVerification.checks] };
	}
	return verification;
}
