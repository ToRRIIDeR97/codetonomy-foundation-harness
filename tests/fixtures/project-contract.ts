import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type { AcceptanceCriterion, VerificationCheck, VerificationResult } from "../../packages/contracts/src/index.ts";
import type { HarnessApplication } from "../../packages/runtime/src/index.ts";

const GUARD_TEXT = "do not edit\n";
const GUARD_FILE = "guard.txt";
const MODULE_FILE = "account.mjs";
const EXECUTION_BOUND_MS = 2_000;
const CHECK_IDS = ["exports", "returns", "migration", "unchanged"] as const;
type CheckId = (typeof CHECK_IDS)[number];

const MESSAGES: Record<CheckId, { pass: string; fail: string }> = {
	exports: {
		pass: "account.mjs loads and exports the required functions",
		fail: "account.mjs must load and export functions normalizeAccount({id, label}) and migrateRows(rows)",
	},
	returns: {
		pass: "Returned values match the public contract",
		fail: "normalizeAccount({id, label}) must return exactly {id: String(id), label: label.trim()} with exactly those keys and string values; migrateRows(rows) must return an array whose rows have exactly keys id and label with string values",
	},
	migration: {
		pass: "migrateRows keeps rows in order and count, leaves inputs unchanged, and is idempotent",
		fail: "migrateRows(rows) must accept legacy {key, name} or {id, label} rows and return the corresponding normalized {id, label} rows in input order without mutating inputs, and must be idempotent",
	},
	unchanged: {
		pass: "guard.txt keeps its exact original bytes",
		fail: "guard.txt must keep its exact UTF-8 bytes \"do not edit\" followed by one newline; restore that exact content",
	},
};

interface NormalizeCase {
	input: { id: string | number; label: string };
	expected: { id: string; label: string };
}

interface MigrateCase {
	input: Array<Record<string, unknown>>;
	expected: Array<{ id: string; label: string }>;
}

const NORMALIZE_CASES: NormalizeCase[] = [
	{ input: { id: 5, label: " Ada " }, expected: { id: "5", label: "Ada" } },
	{ input: { id: "zzq", label: "Bob " }, expected: { id: "zzq", label: "Bob" } },
	{ input: { id: 0, label: "  Cara\t" }, expected: { id: "0", label: "Cara" } },
];

const MIGRATE_CASES: MigrateCase[] = [
	{ input: [{ key: 5, name: " Ada " }, { key: 12, name: "Bob\t" }], expected: [{ id: "5", label: "Ada" }, { id: "12", label: "Bob" }] },
	{ input: [{ id: 3, label: " Cara " }, { id: 8, label: "Dan" }], expected: [{ id: "3", label: "Cara" }, { id: "8", label: "Dan" }] },
	{ input: [{ key: 9, name: " Fay" }, { id: 4, label: "Frank " }, { key: 0, name: "Grace" }], expected: [{ id: "9", label: "Fay" }, { id: "4", label: "Frank" }, { id: "0", label: "Grace" }] },
	{ input: [], expected: [] },
	{ input: [{ id: "7", label: "Heather" }, { key: "k7", name: "   " }, { id: 21, label: "  Zoe " }], expected: [{ id: "7", label: "Heather" }, { id: "k7", label: "" }, { id: "21", label: "Zoe" }] },
];

const WORKER_SOURCE = [
	"const { parentPort, workerData } = require(\"node:worker_threads\");",
	"const { pathToFileURL } = require(\"node:url\");",
	"const errorText = (error) => {",
	"  try { return String(error && error.message ? error.message : error).slice(0, 120); } catch { return \"unreportable error\"; }",
	"};",
	"(async () => {",
	"  let mod;",
	"  try {",
	"    mod = await import(pathToFileURL(workerData.modulePath).href);",
	"  } catch (error) {",
	"    parentPort.postMessage({ phase: \"load\", ok: false, error: errorText(error) });",
	"    parentPort.postMessage({ phase: workerData.mode, results: [], complete: true });",
	"    return;",
	"  }",
	"  let hasNormalize = false;",
	"  let hasMigrate = false;",
	"  try {",
	"    hasNormalize = typeof mod.normalizeAccount === \"function\";",
	"    hasMigrate = typeof mod.migrateRows === \"function\";",
	"  } catch (error) {",
	"    parentPort.postMessage({ phase: \"load\", ok: false, error: errorText(error) });",
	"    parentPort.postMessage({ phase: workerData.mode, results: [], complete: true });",
	"    return;",
	"  }",
	"  parentPort.postMessage({ phase: \"load\", ok: true, hasNormalize, hasMigrate });",
	"  const results = [];",
	"  if (workerData.mode === \"normalize\") {",
	"    for (const input of workerData.cases) {",
	"      if (!hasNormalize) { results.push({ ok: false, error: \"missing normalizeAccount\" }); continue; }",
	"      try {",
	"        const value = await mod.normalizeAccount(structuredClone(input));",
	"        results.push({ ok: true, value: structuredClone(value) });",
	"      } catch (error) { results.push({ ok: false, error: errorText(error) }); }",
	"    }",
	"  } else {",
	"    for (const input of workerData.cases) {",
	"      if (!hasMigrate) { results.push({ ok: false, error: \"missing migrateRows\" }); continue; }",
	"      try {",
	"        const callInput = structuredClone(input);",
	"        const out1 = structuredClone(await mod.migrateRows(callInput));",
	"        const inputAfter = structuredClone(callInput);",
	"        let out2;",
	"        let secondOk = true;",
	"        try { out2 = structuredClone(await mod.migrateRows(structuredClone(out1))); } catch (error) { secondOk = false; }",
	"        results.push({ ok: true, out1, inputAfter, out2: secondOk ? out2 : undefined, secondOk });",
	"      } catch (error) { results.push({ ok: false, error: errorText(error) }); }",
	"    }",
	"  }",
	"  parentPort.postMessage({ phase: workerData.mode, results, complete: true });",
	"})().catch((error) => { parentPort.postMessage({ phase: \"fatal\", error: errorText(error) }); });",
].join("\n");

interface WorkerLoadReport {
	ok: boolean;
	hasNormalize: boolean;
	hasMigrate: boolean;
}

interface WorkerCallResult {
	ok?: boolean;
	value?: unknown;
	out1?: unknown;
	out2?: unknown;
	inputAfter?: unknown;
	secondOk?: boolean;
}

interface WorkerReport {
	load?: WorkerLoadReport;
	results?: WorkerCallResult[];
	complete: boolean;
}

async function runWorker(mode: "normalize" | "migrate", cases: unknown[], modulePath: string, signal?: AbortSignal): Promise<WorkerReport> {
	const worker = new Worker(WORKER_SOURCE, {
		eval: true,
		workerData: { mode, cases, modulePath },
		execArgv: [],
		stdout: true,
		stderr: true,
		resourceLimits: { maxOldGenerationSizeMb: 128 },
	});
	worker.stdout?.resume();
	worker.stderr?.resume();
	const messages: Array<Record<string, unknown>> = [];
	const report = await new Promise<WorkerReport>((resolvePromise) => {
		let settled = false;
		const settle = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			const loadMessage = [...messages].reverse().find((message) => message.phase === "load");
			const phaseMessage = messages.find((message) => message.phase === mode && Array.isArray(message.results));
			const load = loadMessage
				? { ok: loadMessage.ok === true, hasNormalize: loadMessage.hasNormalize === true, hasMigrate: loadMessage.hasMigrate === true }
				: undefined;
			resolvePromise({
				...(load ? { load } : {}),
				...(phaseMessage ? { results: phaseMessage.results as WorkerCallResult[] } : {}),
				complete: Boolean(phaseMessage && phaseMessage.complete === true),
			});
		};
		const onAbort = (): void => settle();
		const timer = setTimeout(settle, EXECUTION_BOUND_MS);
		signal?.addEventListener("abort", onAbort, { once: true });
		worker.on("message", (message) => messages.push(message as Record<string, unknown>));
		worker.on("error", settle);
		worker.on("exit", () => setImmediate(settle));
	});
	await worker.terminate();
	return report;
}

const exactRow = (value: unknown): value is { id: string; label: string } =>
	typeof value === "object" && value !== null && !Array.isArray(value)
	&& Object.keys(value as object).sort().join(",") === "id,label"
	&& typeof (value as { id?: unknown }).id === "string"
	&& typeof (value as { label?: unknown }).label === "string";

const sameValue = (left: unknown, right: unknown): boolean => {
	if (left === right) return true;
	if (typeof left !== typeof right || left === null || right === null || typeof left !== "object") return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		return Array.isArray(left) && Array.isArray(right) && left.length === right.length
			&& left.every((item, index) => sameValue(item, right[index]));
	}
	const leftKeys = Object.keys(left as object).sort();
	const rightKeys = Object.keys(right as object).sort();
	return leftKeys.length === rightKeys.length
		&& leftKeys.every((key, index) => key === rightKeys[index] && sameValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
};

const failClosed = (): VerificationResult => ({
	passed: false,
	checks: CHECK_IDS.map((id) => ({ id, passed: false, message: MESSAGES[id].fail })),
	outcomeChecks: CHECK_IDS.length,
});

const check = (id: CheckId, passed: boolean): VerificationCheck => ({ id, passed, message: MESSAGES[id][passed ? "pass" : "fail"] });

export function createProjectContract(): HarnessApplication {
	return {
		id: "project-contract",
		compileTask(input) {
			const objective = typeof input.objective === "string" ? input.objective.trim() : "";
			if (!objective) throw new Error("Task objective cannot be empty");
			const criteria: AcceptanceCriterion[] = [...(input.acceptanceCriteria ?? [])];
			for (const criterion of [
				{ id: "non-empty-output", description: "The agent returns a non-empty answer", required: true },
				{ id: "runtime-complete", description: "The runtime completes without a provider or tool error", required: true },
				{ id: "workspace-change", description: "The agent completes an approved workspace change", required: true },
			] as const) {
				if (!criteria.some(({ id }) => id === criterion.id)) criteria.push({ ...criterion });
			}
			return {
				id: randomUUID(),
				objective,
				inputs: (input.files ?? []).map((file, index) => ({
					id: `input-${index}`,
					kind: "file",
					value: resolve(input.workspaceRoot ?? process.cwd(), file),
				})),
				requiredCapabilities: ["agent-response", "workspace-write"],
				prohibitions: [],
				acceptanceCriteria: criteria,
				riskClass: "medium",
			};
		},
		async verify({ workspaceRoot, signal }) {
			signal?.throwIfAborted();
			try {
				const root = resolve(workspaceRoot);
				const modulePath = join(root, MODULE_FILE);
				const guardBytes = Buffer.from(GUARD_TEXT, "utf8");
				const guardIntact = async (): Promise<boolean> => {
					try {
						return (await readFile(join(root, GUARD_FILE))).equals(guardBytes);
					} catch {
						return false;
					}
				};
				const guardIntactBefore = await guardIntact();
				const [normalizeReport, migrateReport] = await Promise.all([
					runWorker("normalize", NORMALIZE_CASES.map((item) => item.input), modulePath, signal),
					runWorker("migrate", MIGRATE_CASES.map((item) => item.input), modulePath, signal),
				]);
				signal?.throwIfAborted();
				const guardPasses = guardIntactBefore && (await guardIntact());

				const loadReports = [normalizeReport.load, migrateReport.load].filter((value): value is WorkerLoadReport => Boolean(value));
				const exportsPass = loadReports.some((load) => load.ok && load.hasNormalize && load.hasMigrate);

				const normalizeResults = normalizeReport.results ?? [];
				let returnsPass = normalizeReport.complete && normalizeResults.length === NORMALIZE_CASES.length;
				if (returnsPass) {
					for (const [index, result] of normalizeResults.entries()) {
						const expected = NORMALIZE_CASES[index]!.expected;
						if (!result.ok || !exactRow(result.value) || result.value.id !== expected.id || result.value.label !== expected.label) {
							returnsPass = false;
							break;
						}
					}
				}
				if (returnsPass) {
					const migrateResults = migrateReport.results ?? [];
					if (!migrateReport.complete || migrateResults.length !== MIGRATE_CASES.length) {
						returnsPass = false;
					} else {
						for (const result of migrateResults) {
							const rows = result.out1;
							if (!result.ok || !Array.isArray(rows) || !rows.every(exactRow)) {
								returnsPass = false;
								break;
							}
						}
					}
				}

				const migrateResults = migrateReport.results ?? [];
				let migrationPass = migrateReport.complete && migrateResults.length === MIGRATE_CASES.length;
				if (migrationPass) {
					for (const [index, result] of migrateResults.entries()) {
						const item = MIGRATE_CASES[index]!;
						const rows = result.out1;
						if (!result.ok || !Array.isArray(rows)) {
							migrationPass = false;
							break;
						}
						const rowsPass = rows.length === item.expected.length && rows.every((row, rowIndex) => {
							const expected = item.expected[rowIndex]!;
							return exactRow(row) && row.id === expected.id && row.label === expected.label;
						});
						if (!rowsPass || !sameValue(result.inputAfter, item.input) || result.secondOk !== true || !sameValue(result.out2, result.out1)) {
							migrationPass = false;
							break;
						}
					}
				}

				const checks: VerificationCheck[] = [
					check("exports", exportsPass),
					check("returns", returnsPass),
					check("migration", migrationPass),
					check("unchanged", guardPasses),
				];
				return { passed: checks.every(({ passed }) => passed), checks, outcomeChecks: checks.length };
			} catch (error) {
				signal?.throwIfAborted();
				return failClosed();
			}
		},
	};
}
