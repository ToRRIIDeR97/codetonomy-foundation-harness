import type { ExecutionResultKind, TaskSpecification, VerificationCheck, VerificationResult, WorkspaceMutationRisk } from "@agent-harness/contracts";

export interface VerificationEvidence {
	task?: TaskSpecification;
	completedToolIds?: Iterable<string>;
	/** Module tools that count as workspace evidence, in addition to the core inspection tools. */
	workspaceEvidenceToolIds?: Iterable<string>;
	commandExitCodes?: Iterable<number | null>;
	commandRuns?: Iterable<{ argv: readonly string[]; exitCode: number | null; resultKind?: ExecutionResultKind; mutationRisk?: WorkspaceMutationRisk }>;
	fileEvidence?: Iterable<{ target: string; action: "read" | "write" | "exists" | "delete"; callId: string; current: boolean }>;
}

const REFUSAL = /\b(?:i (?:do not|don't|cannot|can't) (?:have|access)|no (?:file|filesystem|code|repository|workspace).{0,40}tools?|(?:unable|not able) to (?:access|inspect|scan|read)|please (?:provide|share).{0,80}(?:codebase|repository|files?))\b/is;
const WORKSPACE_TOOLS = new Set(["list_workspace", "search_workspace", "inspect_workspace"]);

export const commandMatches = (argv: readonly string[], expected: readonly string[], allowExtraArguments = false): boolean => {
	const normalize = (values: readonly string[]) => {
		const result = [...values];
		result[0] = (result[0]?.split(/[\\/]/).at(-1) ?? "");
		if (["npm", "pnpm", "yarn", "bun"].includes(result[0]!) && result[1] === "run") result.splice(1, 1);
		return result;
	};
	const actual = normalize(argv), wanted = normalize(expected);
	return (allowExtraArguments || actual.length === wanted.length) && wanted.every((value, index) => actual[index] === value);
};

export function verifyOutput(output: string, runtimeError?: string, evidence: VerificationEvidence = {}): VerificationResult {
	const completedToolIds = new Set(evidence.completedToolIds ?? []);
	const workspaceTools = new Set([...WORKSPACE_TOOLS, ...(evidence.workspaceEvidenceToolIds ?? [])]);
	const commandRuns = [...(evidence.commandRuns ?? [])];
	const commands = evidence.task?.acceptanceCriteria.filter(({ action }) => action === "command") ?? [];
	const expectedCommand = commands[0]?.command;
	const commandSucceeded = commands.length > 0 && commands.every(({ command }) => command && commandRuns.some(({ argv, exitCode, resultKind }) => exitCode === 0 && resultKind !== "failure" && resultKind !== "no-matches" && commandMatches(argv, command)));
	const files = [...(evidence.fileEvidence ?? [])];
	const obligationChecks: VerificationCheck[] = (evidence.task?.acceptanceCriteria ?? []).filter(({ action }) => action).map((criterion) => ({
		id: criterion.id,
		passed: criterion.action === "command"
			? Boolean(criterion.command && commandRuns.some(({ argv, exitCode, resultKind }) => exitCode === 0 && resultKind !== "failure" && resultKind !== "no-matches" && commandMatches(argv, criterion.command!)))
			: files.some(({ target, action, current }) => target === criterion.target && action === criterion.action && current),
		message: `Required outcome: ${criterion.description}`,
	}));
	const checks: VerificationCheck[] = [
		{
			id: "non-empty-output",
			passed: output.trim().length > 0,
			message: output.trim() ? "Agent produced output" : "Agent output was empty",
		},
		{
			id: "runtime-complete",
			passed: !runtimeError,
			message: runtimeError ?? "Runtime completed without an error",
		},
		{
			id: "agent-completed-task",
			passed: !REFUSAL.test(output),
			message: REFUSAL.test(output) ? "Agent declined or claimed required access was unavailable" : "Agent did not refuse the task",
		},
		...(evidence.task?.requiredCapabilities.includes("workspace-inspection")
			? [{
				id: "workspace-evidence",
				passed: [...completedToolIds].some((id) => workspaceTools.has(id)),
				message: [...completedToolIds].some((id) => workspaceTools.has(id))
					? "Agent inspected workspace evidence"
					: "Agent answered a workspace task without inspecting workspace evidence",
			}]
			: []),
		...(evidence.task?.requiredCapabilities.includes("workspace-write")
			? [{
				id: "workspace-change",
				passed: files.some(({ action, current }) => (action === "write" || action === "delete") && current),
				message: files.some(({ action, current }) => (action === "write" || action === "delete") && current)
					? "Agent completed an approved workspace change"
					: "Agent did not complete the requested workspace change",
			}]
			: []),
		...(evidence.task?.requiredCapabilities.includes("workspace-command")
			? [{
				id: "command-success",
				passed: commandSucceeded,
				message: commandSucceeded
					? `Agent completed${expectedCommand ? ` ${expectedCommand.join(" ")}` : " a sandboxed command"} successfully`
					: `Agent did not complete${expectedCommand ? ` the requested ${expectedCommand.join(" ")}` : " a sandboxed command"} successfully`,
			}]
			: []),
		...obligationChecks,
	];
	for (const criterion of evidence.task?.acceptanceCriteria ?? []) {
		if (criterion.required && !checks.some(({ id }) => id === criterion.id)) checks.push({ id: criterion.id, passed: false, message: `Unsupported required criterion: ${criterion.description}` });
	}
	return { passed: checks.every(({ passed }) => passed), checks };
}
