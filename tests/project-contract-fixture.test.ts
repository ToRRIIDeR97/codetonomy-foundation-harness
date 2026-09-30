import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProjectContract } from "./fixtures/project-contract.ts";
import { createHarness, type HarnessProviderConfiguration } from "../packages/runtime/src/index.ts";

const GOOD = `export function normalizeAccount(x){return {id:String(x.id),label:x.label.trim()}}\nexport function migrateRows(xs){return xs.map(x=>({id:String(x.id??x.key),label:(x.label??x.name).trim()}))}\n`;
const FIXTURE_VALUES = /Ada|Bob|Cara|Dan|Fay|Frank|Grace|Heather|Zoe|k7|zzq/;

async function workspace(t: any, source: string | null = GOOD, guard = "do not edit\n") {
	const root = await mkdtemp(join(tmpdir(), "project-contract-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	if (source !== null) await writeFile(join(root, "account.mjs"), source);
	await writeFile(join(root, "guard.txt"), guard);
	return root;
}

const verify = (root: string, output = "All generated tests passed.") =>
	createProjectContract().verify({ workspaceRoot: root, task: { acceptanceCriteria: [] } as never, output, artifacts: [] });

const failedIds = (result: { checks: Array<{ id: string; passed: boolean }> }) => result.checks.filter(({ passed }) => !passed).map(({ id }) => id);

const sse = (content: string) => new Response([
	{ id: "r", object: "chat.completion.chunk", created: 1, model: "small", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] },
	{ id: "r", object: "chat.completion.chunk", created: 1, model: "small", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });

const providerConfiguration: HarnessProviderConfiguration = {
	id: "local", name: "Local", kind: "openai-compatible", baseUrl: "https://fixture.invalid/v1",
	modelMetadata: { id: "small", name: "Small", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 1024, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
};

test("an alternative valid implementation passes while shape, order, mutation and lossy mutants fail their contract checks", async (t) => {
	const root = await workspace(t, `export function normalizeAccount({ id, label }) {
  return { label: label.trim(), id: String(id) };
}
export function migrateRows(rows) {
  const migrated = [];
  for (const row of rows) {
    const id = row.id !== undefined ? row.id : row.key;
    const label = (row.label !== undefined ? row.label : row.name).trim();
    migrated.push({ label, id: String(id) });
  }
  return migrated;
}
`);
	assert.deepEqual(failedIds(await verify(root)), []);
	for (const [ids, source] of [
		[["returns"], GOOD.replace("return {id:String(x.id),label:x.label.trim()}","return {id:String(x.id),label:x.label.trim(),extra:1}")],
		[["returns", "migration"], GOOD.replace("return xs.map(x=>({id:String(x.id??x.key),label:(x.label??x.name).trim()}))","return xs.map(x=>({id:String(x.id??x.key),label:(x.label??x.name).trim(),extra:1}))")],
		[["migration"], GOOD.replace("return xs.map(x=>({id:String(x.id??x.key),label:(x.label??x.name).trim()}))","return xs.map(x=>({id:String(x.id??x.key),label:(x.label??x.name).trim()})).reverse()")],
		[["migration"], GOOD.replace("return xs.map(x=>({id:String(x.id??x.key),label:(x.label??x.name).trim()}))","const out=xs.map(x=>({id:String(x.id??x.key),label:(x.label??x.name).trim()}));xs.length=0;return out")],
		[["migration"], GOOD.replace("return xs.map(x=>({id:String(x.id??x.key),label:(x.label??x.name).trim()}))","return []")],
	] as const) {
		await writeFile(join(root, "account.mjs"), source);
		const result = await verify(root);
		assert.equal(result.passed, false);
		for (const id of ids) assert.ok(result.checks.some((c: any) => c.id === id && !c.passed), id);
		assert.ok(result.checks.some((c: any) => c.id === "unchanged" && c.passed));
	}
	await writeFile(join(root, "account.mjs"), GOOD);
	assert.deepEqual(failedIds(await verify(root)), [], "repaired source must be reloaded");
});

test("missing, malformed and non-exporting modules fail closed with stable check ids", async (t) => {
	for (const source of [null, "export function normalizeAccount(", "export const unrelated = 1;"] as const) {
		const root = await workspace(t, source);
		const result = await verify(root);
		assert.equal(result.passed, false);
		assert.deepEqual(failedIds(result).sort(), ["exports", "migration", "returns"]);
		assert.ok(result.checks.some((c: any) => c.id === "unchanged" && c.passed));
	}
});

test("runtime exceptions in candidate functions fail closed without sinking independent checks", async (t) => {
	const root = await workspace(t, `export function normalizeAccount(x){throw new Error("nope")}\nexport function migrateRows(xs){return xs.map(x=>({id:String(x.id??x.key),label:(x.label??x.name).trim()}))}\n`);
	let result = await verify(root);
	assert.equal(result.passed, false);
	assert.deepEqual(failedIds(result), ["returns"]);
	await writeFile(join(root, "account.mjs"), `export function normalizeAccount(x){return {id:String(x.id),label:x.label.trim()}}\nexport function migrateRows(xs){throw new Error("nope")}\n`);
	result = await verify(root);
	assert.equal(result.passed, false);
	assert.deepEqual(failedIds(result).sort(), ["migration", "returns"]);
	assert.ok(result.checks.some((c: any) => c.id === "exports" && c.passed));
});

test("verification bounds hanging imports and hanging calls and never edits the project", async (t) => {
	const hang = async (source: string) => {
		const root = await workspace(t, source);
		const started = Date.now();
		const result = await verify(root);
		assert.ok(Date.now() - started < 10_000, "verification must finish within the execution bound");
		assert.equal(result.passed, false);
		assert.deepEqual(result.checks.map((c: any) => c.id), ["exports", "returns", "migration", "unchanged"]);
		return result;
	};
	const hungImport = await hang(`while(true){}\n${GOOD}`);
	assert.deepEqual(failedIds(hungImport).sort(), ["exports", "migration", "returns"]);
	const hungCall = await hang(`export function normalizeAccount(x){while(true){}}\nexport function migrateRows(xs){return xs.map(x=>({id:String(x.id??x.key),label:(x.label??x.name).trim()}))}\n`);
	assert.ok(hungCall.checks.some((c: any) => c.id === "returns" && !c.passed));
	assert.ok(hungCall.checks.some((c: any) => c.id === "migration" && c.passed), "independent checks stay isolated from a hanging call");
	for (const source of [GOOD, `export function normalizeAccount(`]) {
		const root = await workspace(t, source);
		const before = { module: await readFile(join(root, "account.mjs"), "utf8").catch(() => null), guard: await readFile(join(root, "guard.txt"), "utf8").catch(() => null) };
		await verify(root);
		const after = { module: await readFile(join(root, "account.mjs"), "utf8").catch(() => null), guard: await readFile(join(root, "guard.txt"), "utf8").catch(() => null) };
		assert.deepEqual(after, before, "verification must never change the project");
	}
});

test("the unchanged verdict observes candidate side effects and pre-altered guards after worker termination", async (t) => {
	const root = await workspace(t, `import {writeFileSync} from 'node:fs';\nwriteFileSync(new URL('./guard.txt', import.meta.url), 'mutated mid-run');\n${GOOD}`);
	const result = await verify(root);
	assert.equal(result.passed, false);
	assert.deepEqual(failedIds(result), ["unchanged"], "behavior checks pass but guard mutation during execution must fail");
	assert.equal(await readFile(join(root, "guard.txt"), "utf8"), "mutated mid-run", "verification must not restore the file");
	const preAltered = await workspace(t, GOOD, "altered before verification\n");
	const damaged = await verify(preAltered);
	assert.equal(damaged.passed, false);
	assert.ok(damaged.checks.some((c: any) => c.id === "unchanged" && !c.passed));
});

test("check messages describe the public contract without fixture values or source answers", async (t) => {
	const root = await workspace(t, GOOD.replace("return {id:String(x.id),label:x.label.trim()}", "return String(x.id)"));
	const result = await verify(root);
	const rendered = JSON.stringify(result.checks);
	assert.match(rendered, /normalizeAccount/);
	assert.match(rendered, /migrateRows/);
	assert.doesNotMatch(rendered, FIXTURE_VALUES);
});

test("exhausted repair of a claim-only project fails closed with contract feedback", async (t) => {
	const root = await workspace(t, GOOD.replace("return {id:String(x.id),label:x.label.trim()}", "return String(x.id)"));
	const bodies: unknown[] = [];
	const result = await createHarness().run({
		objective: "Implement the account module according to its public contract", workspaceRoot: root, traceDirectory: join(root, "runs"),
		permissionMode: "auto", provider: "local", modelId: "small", maxModelTurns: 5, maxOutputTokens: 256, providerRetryLimit: 0,
		providerConfiguration, application: createProjectContract(),
		providerFetch: async (_input, init) => { bodies.push(JSON.parse(String(init?.body))); return sse("All generated tests passed."); },
	});
	assert.equal(result.verification.passed, false);
	assert.ok(result.verification.checks.some((c) => c.id === "project-contract:returns" && !c.passed));
	assert.ok(bodies.length <= 5, "repair work stays bounded");
	assert.match(JSON.stringify(bodies[1]), /project-contract:returns/);
});

test("a throwing application verifier fails the run closed", async (t) => {
	const root = await workspace(t);
	const result = await createHarness().run({
		objective: "Implement the account module according to its public contract", workspaceRoot: root, traceDirectory: join(root, "runs"),
		permissionMode: "auto", provider: "local", modelId: "small", maxModelTurns: 5, maxOutputTokens: 256, providerRetryLimit: 0,
		providerConfiguration,
		application: { ...createProjectContract(), verify: async () => { throw new Error("verifier exploded"); } },
		providerFetch: async () => sse("Done."),
	});
	assert.equal(result.verification.passed, false);
	assert.ok(result.verification.checks.some((c) => c.id === "project-contract:verifier" && !c.passed));
});
