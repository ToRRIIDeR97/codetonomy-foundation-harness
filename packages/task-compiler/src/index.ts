import { createHash, randomUUID } from "node:crypto";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { AcceptanceCriterion, RiskClass, TaskInput, TaskSpecification } from "@agent-harness/contracts";

export interface CompileTaskInput {
	objective: string;
	files?: string[];
	riskClass?: RiskClass;
	workspaceRoot?: string;
	acceptanceCriteria?: AcceptanceCriterion[];
	/** The run may change only these paths (a delegated child's write claim). */
	writePaths?: string[];
}

const WRITE_INTENT = /\b(add|build|change|create|delete|develop|edit|fix|generate|implement|make|modify|move|patch|refactor|remove|rename|update|write)\b/;
const WRITE_NEGATION = /\b(?:do not|don't|dont|never|no need to|not to|without)\b/;
const hasWriteIntent = (objective: string): boolean => objective
	.split(/(?:[.!?;,\n]+|\b(?:but|however|instead|then|now)\b)/)
	.some((clause) => WRITE_INTENT.test(clause) && !WRITE_NEGATION.test(clause.slice(0, clause.search(WRITE_INTENT))));

// Deliberately limited to explicit file actions and known command forms. Complex
// acceptance language is left unverified rather than inferred from tool success.
const COMMAND = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|lint|build|check|checks|typecheck|type-check)|(?:cargo|go|dotnet|mvn|gradle|swift)\s+(?:test|check|build|verify)|(?:python(?:3)?)\s+-m\s+(?:pytest|unittest)|pytest|vitest|jest|mocha|ava)\b/gi;
const FILE_ACTION = /(?<![\w./\\-])(?:(?:check|verify|determine)(?=\s+(?:whether\s+)?(?:[\w./`-]+\s+)?(?:exists?|absent|missing)\b)|(?:add|build|change|create|delete|develop|edit|fix|generate|implement|make|modify|move|patch|refactor|remove|rename|update|write|read|inspect|review|summarize))(?![\w./\\-])/gi;
// Words before a file that make it an input of the write rather than its object.
const INPUT_MARKER = /\b(?:from|using|per|for|like|than|according\s+to|based\s+on|(?:described|defined|specified)\s+in|summar(?:y|ies|i[sz](?:e|es|ed|ing))|describ(?:e|es|ed|ing)|match(?:es|ed|ing)?|cop(?:y|ies)\s+of)\b/;
// Words directly before a later file that make it another object of the write.
const LIST_SEPARATOR = /^[\s,]*(?:(?:and|or|nor)\s+)?(?:also\s+)?(?:the\s+)?(?:files?\s+)?$/;
const DESTINATION = /\b(?:to|into|at|as|named|called)\s+(?:(?:the|a|an|new|file|path|output|named|called)\s+)*$/;

// Whether a file named in a write or delete clause is its target or an input. The first file is the
// target unless an input marker precedes it ("a summary of x" when creating, "from x", "based on x");
// "update the contents of x" keeps x as the target. A listed file ("a.ts and b.ts") shares the previous
// file's role. Any other later file is a target only after a destination ("to x", "named x"):
// "in", "of" and "with" introduce inputs ("to match the schema in b.md").
const mutationRole = (between: string, previous: "target" | "input" | undefined, creates: boolean): "target" | "input" => {
	if (previous && LIST_SEPARATOR.test(between)) return previous;
	if (INPUT_MARKER.test(between) || (creates && /\bof\b/.test(between))) return "input";
	if (!previous) return "target";
	if (/\b(?:of|in|with)\b/.test(between)) return "input";
	return DESTINATION.test(between) ? "target" : "input";
};

export function compileObligations(objective: string, workspaceRoot: string): { criteria: AcceptanceCriterion[]; prohibitions: NonNullable<TaskSpecification["prohibitions"]> } {
	const criteria: AcceptanceCriterion[] = [];
	const prohibitions: NonNullable<TaskSpecification["prohibitions"]> = [];
	for (const clause of objective.split(/(?:[;!\n]+|\.(?:\s|$)|\b(?:but|however|then)\b|\band (?=(?:read|inspect|write|create|update|edit|run|check|verify)\b))/i)) {
		const commandNegative = (index: number) => WRITE_NEGATION.test(clause.slice(0, index).toLowerCase());
		const conditional = /\b(?:if|unless|when|should|could|might|may|consider)\b/i.test(clause);
		for (const match of clause.matchAll(COMMAND)) {
			const command = match[0].trim().split(/\s+/);
			if (commandNegative(match.index)) prohibitions.push({ action: "command", command });
			else if (!conditional) criteria.push({ id: `command-${criteria.length}`, description: `Complete ${command.join(" ")} successfully`, required: true, action: "command", command, evidence: "zero-exit" });
		}
		if (conditional) continue;
		const actions = [...clause.matchAll(FILE_ACTION)];
		const negatedActions = new Set<number>();
		for (const [index, match] of actions.entries()) {
			const verb = match[0].toLowerCase();
			const segment = clause.slice(match.index, actions[index + 1]?.index);
			const action = /^(?:check|verify|determine)$/.test(verb) && /\b(?:exists?|absent|missing)\b/i.test(segment) ? "exists"
				: /^(?:read|inspect|review|summarize)$/.test(verb) ? "read"
				: /^(?:delete|remove)$/.test(verb) ? "delete"
				: /^(?:add|build|change|create|delete|develop|edit|fix|generate|implement|make|modify|move|patch|refactor|remove|rename|update|write)$/.test(verb) ? "write"
				: undefined;
			if (!action) continue;
			const previous = actions[index - 1];
			// "never write, edit, or overwrite x" negates every verb in the list, not only the first.
			const negative = previous
				? negatedActions.has(index - 1) && /^[\s,]*(?:(?:and|or|nor)\s+)?$/i.test(clause.slice(previous.index + previous[0].length, match.index))
				: WRITE_NEGATION.test(clause.slice(0, match.index).toLowerCase());
			if (negative) negatedActions.add(index);
			const literal = action === "write" ? segment.match(/\bcontaining exactly\s+(?:"([^"\n]*)"|'([^'\n]*)'|([A-Za-z0-9_-]+))\s*$/i) : undefined;
			const targets = literal ? segment.slice(0, literal.index) : segment;
			// Only the verb's objects are mutation targets. "Implement module.ts from spec.md", "write a
			// summary of notes/a.md to out.txt" and "update a.ts to match the schema in b.md" also name
			// inputs. Leave those to the agent instead of inventing a mandatory edit that conflicts with
			// preserving them.
			const mutation = action === "write" || action === "delete";
			const creates = /^(?:add|build|create|develop|generate|implement|make|write)$/.test(verb);
			let previousRole: "target" | "input" | undefined;
			let previousEnd = verb.length;
			let qualifiedTargetSeen = false;
			for (const targetMatch of targets.matchAll(/(?:`([^`]+)`|(?<![\w./-])((?:\/|\.{1,2}\/)?(?:[\w@.-]+\/)*[\w@.-]+\.[a-zA-Z0-9]+)\b)/g)) {
				const file = targetMatch[1] ?? targetMatch[2]!;
				if (/\s/.test(file) || !file.includes(".")) continue;
				const between = targets.slice(previousEnd, targetMatch.index).toLowerCase();
				previousEnd = targetMatch.index + targetMatch[0].length;
				const role = mutation ? mutationRole(between, previousRole, creates) : "target";
				previousRole = role;
				if (role === "input") continue;
				// "Read specs/a.md and b.md" does not establish whether b.md is
				// rooted at the workspace or specs/. Explicit ./b.md is unambiguous.
				if (!negative && qualifiedTargetSeen && !/[/\\]/.test(file)) continue;
				qualifiedTargetSeen ||= /[/\\]/.test(file);
				const target = resolve(workspaceRoot, file.replace(/^\/workspace\//, ""));
				if (negative) { if (action === "write" || action === "delete") prohibitions.push({ action: "write", target }); continue; }
				criteria.push({ id: `file-${criteria.length}`, description: `${action} ${file}`, required: true, action, target, evidence: action === "write" || action === "delete" ? "changed-state" : action === "read" ? "read-receipt" : "file-state", ...(literal ? { expectedContent: literal[1] ?? literal[2] ?? literal[3]! } : {}) });
			}
		}
	}
	return { criteria, prohibitions };
}

export function compileTask(input: CompileTaskInput): TaskSpecification {
	const objective = input.objective.trim();
	if (!objective) throw new Error("Task objective cannot be empty");

	const obligations = compileObligations(objective, input.workspaceRoot ?? process.cwd());
	if (input.writePaths?.length) {
		// A run limited to writePaths cannot change anything else, so an inferred change outside them is
		// never a requirement it could meet; it is recorded as a prohibition instead.
		const claims = input.writePaths.map((path) => resolve(input.workspaceRoot ?? process.cwd(), path.trim()));
		const claimed = (target: string) => claims.some((claim) => {
			const local = relative(claim, target);
			return local === "" || (!local.startsWith("..") && !isAbsolute(local));
		});
		obligations.criteria = obligations.criteria.filter((criterion) => {
			if ((criterion.action !== "write" && criterion.action !== "delete") || !criterion.target || claimed(criterion.target)) return true;
			obligations.prohibitions.push({ action: "write", target: criterion.target });
			return false;
		});
	}
	const reservedCriteria = new Set(["non-empty-output", "runtime-complete", "workspace-evidence", "workspace-change", "command-success"]);
	for (const criterion of input.acceptanceCriteria ?? []) {
		if (!criterion.id || !criterion.description || typeof criterion.required !== "boolean"
			|| (criterion.expectedContent !== undefined && (typeof criterion.expectedContent !== "string" || Buffer.byteLength(criterion.expectedContent) > 32_000 || !criterion.target || !["read", "write", "exists"].includes(criterion.action ?? "")))) throw new Error("Invalid application acceptance criterion");
		if (reservedCriteria.has(criterion.id) || obligations.criteria.some(({ id }) => id === criterion.id)) throw new Error(`Duplicate acceptance criterion: ${criterion.id}`);
		obligations.criteria.push({ ...criterion, ...(criterion.target ? { target: resolve(input.workspaceRoot ?? process.cwd(), criterion.target) } : {}) });
	}
	const declaredDocuments = obligations.criteria.filter(({ action, target }) => action === "read" && target && [".pdf", ".xlsx", ".pptx"].includes(extname(target).toLowerCase())).map(({ target }) => target!);
	const files = [...new Set([...(input.files ?? []), ...declaredDocuments].map(file => resolve(input.workspaceRoot ?? process.cwd(), file)))];
	const inputs: TaskInput[] = files.map((file) => ({
		id: createHash("sha256").update(resolve(input.workspaceRoot ?? process.cwd(), file)).digest("hex").slice(0, 16),
		kind: "file",
		value: resolve(input.workspaceRoot ?? process.cwd(), file),
	}));
	const lower = objective.toLowerCase();
	const writeIntent = hasWriteIntent(lower);
	const genericCommand = objective.split(/[;.!?\n]/).some((clause) => !WRITE_NEGATION.test(clause.toLowerCase()) && !/\b(if|unless|when|could|should|might)\b/i.test(clause) && /\b(?:execute|lint|typecheck|type-check|compile)\b|\brun (?:the )?(?:tests?|build|checks?|suite)\b/i.test(clause));
	const commandIntent = genericCommand || obligations.criteria.some(({ action }) => action === "command");
	if (genericCommand && !obligations.criteria.some(({ action }) => action === "command")) obligations.criteria.push({ id: "unspecified-command", action: "unsupported", required: true, description: "The requested command is not explicit enough for deterministic verification" });
	const mutationIntent = writeIntent || obligations.criteria.some(({ action }) => action === "write" || action === "delete");
	const workspaceIntent = mutationIntent || obligations.criteria.some(({ target }) => Boolean(target))
		|| /\b(codebase|repository|repo|workspace|project files?|source tree|code files?|implementation|existing code|tests?|package\.json|readme)\b/.test(lower)
		|| /\b(scan|inspect|search|grep|find|debug|run tests?)\b/.test(lower);
	const requiredCapabilities = [
		"agent-response",
		...(inputs.length || workspaceIntent ? ["workspace-inspection"] : []),
		...(mutationIntent ? ["workspace-write"] : []),
		...(commandIntent ? ["workspace-command"] : []),
	];

	return {
		id: randomUUID(),
		objective,
		inputs,
		requiredCapabilities: [...new Set(requiredCapabilities)],
		prohibitions: obligations.prohibitions,
		acceptanceCriteria: [
			...obligations.criteria,
			{ id: "non-empty-output", description: "The agent returns a non-empty answer", required: true },
			{ id: "runtime-complete", description: "The runtime completes without a provider or tool error", required: true },
			...(inputs.length || workspaceIntent
				? [{ id: "workspace-evidence", description: "The agent inspects workspace evidence before answering", required: true }]
				: []),
			...(mutationIntent
				? [{ id: "workspace-change", description: "The agent completes an approved workspace change", required: true }]
				: []),
			...(commandIntent
				? [{ id: "command-success", description: "The agent completes a sandboxed command successfully", required: true }]
				: []),
		],
		riskClass: input.riskClass ?? (mutationIntent || commandIntent ? "medium" : "low"),
	};
}
