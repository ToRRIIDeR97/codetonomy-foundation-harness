import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import test from "node:test";
import { validateRunRecoveryState, type RunRecoveryMutation } from "../packages/contracts/src/index.ts";
import { mutationFromRecoverableError, recoverableErrorFromMutation } from "../packages/runtime/src/recovery-mutation.ts";

const root = resolve("recovery-workspace");

const fullMutation = (): RunRecoveryMutation => ({
	toolName: "run_workspace_command",
	message: "Command timed out; effects unknown",
	outcome: "effects-unknown",
	target: join(root, "src", "index.ts"),
	retryCommand: ["npm", "test"],
	retryCwd: root,
	optionalDiagnostic: false,
	corrected: true,
	correctionRevisions: { [join(root, "src", "index.ts")]: "a".repeat(64) },
	failureEventId: randomUUID(),
	obligationId: "criterion-1",
});

test("every recovery mutation field survives save and reload", () => {
	const saved = fullMutation();
	const restored = recoverableErrorFromMutation(saved);
	assert.equal(restored.modelTurn, 0);
	assert.equal(restored.resolved, false);
	assert.equal(restored.eventId, saved.failureEventId);
	const resaved = mutationFromRecoverableError(restored);
	assert.deepEqual(resaved, saved);
	// Key order is part of the persisted bytes; keep it stable.
	assert.deepEqual(Object.keys(resaved), Object.keys(saved));
	validateRunRecoveryState({ version: 1, uncertainMutations: [resaved], spend: { costUsd: 0, totalTokens: 0 } });
});

test("restored mutations never share arrays or objects with the saved state", () => {
	const saved = fullMutation();
	const restored = recoverableErrorFromMutation(saved);
	restored.retryCommand!.push("--changed");
	restored.correctionRevisions![join(root, "other.ts")] = "b".repeat(64);
	assert.deepEqual(saved.retryCommand, ["npm", "test"]);
	assert.deepEqual(Object.keys(saved.correctionRevisions!), [join(root, "src", "index.ts")]);
});

test("a minimal mutation gets a parent event id and saves without optional fields", () => {
	const restored = recoverableErrorFromMutation({ toolName: "write_workspace", message: "Interrupted", outcome: "effects-unknown" });
	assert.match(restored.eventId!, /^[0-9a-f-]{36}$/);
	const saved = mutationFromRecoverableError({ ...restored, eventId: undefined, message: "x".repeat(2_000) });
	assert.deepEqual(saved, { toolName: "write_workspace", message: "x".repeat(1_000), outcome: "effects-unknown" });
});
