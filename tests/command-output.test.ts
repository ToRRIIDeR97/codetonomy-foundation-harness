import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { COMMAND_OUTPUT_LIMIT_BYTES, COMMAND_OUTPUT_PREVIEW_BYTES, COMMAND_OUTPUT_TAIL_BYTES, CommandOutputStore, bashTool, readToolOutputTool, RUN_OUTPUT_LIMIT_BYTES, runWorkspaceCommandTool, TOOL_OUTPUT_READ_LIMIT_BYTES } from "../packages/tools/src/index.ts";

const readAll = async (store: CommandOutputStore, outputId: string): Promise<string> => {
	let text = "";
	let offset = 0;
	while (true) {
		const range = await store.read(outputId, offset, TOOL_OUTPUT_READ_LIMIT_BYTES);
		text += range.text;
		if (range.nextOffset === undefined) return text;
		offset = range.nextOffset;
	}
};

test("command output references preserve redacted UTF-8 across preview and reader boundaries", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-output-reader-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const secret = "secret-across-stream-chunks";
	const store = new CommandOutputStore({ workspaceRoot: root, outputDirectory: join(root, "capture"), knownSecrets: [secret] });
	const capture = store.createCapture("origin");
	await capture.append(Buffer.from(`🙂head-${"x".repeat(20_000)}${secret.slice(0, 9)}`));
	await capture.append(Buffer.from(`${secret.slice(9)}-tail`));
	const receipt = await capture.finish(true);
	assert.equal(receipt.previewTruncated, true);
	assert.equal(receipt.outputComplete, true);
	assert.ok(receipt.outputId);
	assert.doesNotMatch(receipt.output, new RegExp(secret));
	assert.match(receipt.output, /Output preview omitted/);
	const recovered = await readAll(store, receipt.outputId!);
	assert.equal(recovered, `🙂head-${"x".repeat(20_000)}[REDACTED]-tail`);
	await assert.rejects(store.read(receipt.outputId!, 1, 4), /UTF-8 character boundary/);
	await assert.rejects(store.read(randomUUID(), 0, 16), /Unknown, expired, or unavailable/);
	const other = new CommandOutputStore({ workspaceRoot: root, outputDirectory: join(root, "other") });
	await assert.rejects(other.read(receipt.outputId!, 0, 16), /Unknown, expired, or unavailable/);
	const empty = await store.createCapture("empty").finish(true);
	assert.equal(empty.output, "");
	assert.equal(empty.outputId, undefined);
});

test("command and run quotas keep the accepted prefix and mark it incomplete", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-output-quota-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const secret = "supersecret-12345";
	const commandStore = new CommandOutputStore({
		workspaceRoot: root,
		outputDirectory: join(root, "command-capture"),
		knownSecrets: [secret],
		maxCommandBytes: COMMAND_OUTPUT_PREVIEW_BYTES,
		maxRunBytes: COMMAND_OUTPUT_PREVIEW_BYTES,
	});
	const commandCapture = commandStore.createCapture("command-quota");
	await assert.rejects(
		commandCapture.append(Buffer.from(`${"x".repeat(COMMAND_OUTPUT_PREVIEW_BYTES - 3)}sup-overflow`)),
		(error: unknown) => (error as { kind?: string }).kind === "command-quota",
	);
	const commandReceipt = await commandCapture.finish(false);
	assert.equal(commandReceipt.capturedBytes, COMMAND_OUTPUT_PREVIEW_BYTES);
	assert.equal(commandReceipt.outputComplete, false);
	assert.ok(commandReceipt.outputId);
	assert.match(await readAll(commandStore, commandReceipt.outputId!), /\[REDACTED\]$/);
	const genericPartialStore = new CommandOutputStore({
		workspaceRoot: root,
		outputDirectory: join(root, "generic-partial-capture"),
		maxCommandBytes: COMMAND_OUTPUT_PREVIEW_BYTES,
		maxRunBytes: COMMAND_OUTPUT_PREVIEW_BYTES,
	});
	const genericCapture = genericPartialStore.createCapture("generic-partial-secret");
	await assert.rejects(genericCapture.append(Buffer.from(`${"x".repeat(COMMAND_OUTPUT_PREVIEW_BYTES - 11)}sk-abcdefgh-overflow`)),
		(error: unknown) => (error as { kind?: string }).kind === "command-quota");
	const genericPartialReceipt = await genericCapture.finish(false);
	assert.ok(genericPartialReceipt.outputId);
	assert.doesNotMatch(await readAll(genericPartialStore, genericPartialReceipt.outputId!), /sk-abcdefgh/);
	const utf8Store = new CommandOutputStore({
		workspaceRoot: root,
		outputDirectory: join(root, "utf8-capture"),
		maxCommandBytes: COMMAND_OUTPUT_PREVIEW_BYTES,
		maxRunBytes: COMMAND_OUTPUT_PREVIEW_BYTES,
	});
	const utf8Capture = utf8Store.createCapture("utf8-quota");
	await assert.rejects(utf8Capture.append(Buffer.concat([Buffer.alloc(COMMAND_OUTPUT_PREVIEW_BYTES - 1, 97), Buffer.from("€")])),
		(error: unknown) => (error as { kind?: string }).kind === "command-quota");
	const utf8Receipt = await utf8Capture.finish(false);
	assert.ok(utf8Receipt.outputId);
	assert.equal(await readAll(utf8Store, utf8Receipt.outputId!), "a".repeat(COMMAND_OUTPUT_PREVIEW_BYTES - 1));
	assert.equal(utf8Receipt.outputComplete, false);

	const runStore = new CommandOutputStore({
		workspaceRoot: root,
		outputDirectory: join(root, "run-capture"),
		maxCommandBytes: COMMAND_OUTPUT_PREVIEW_BYTES * 2,
		maxRunBytes: COMMAND_OUTPUT_PREVIEW_BYTES * 2,
	});
	const first = runStore.createCapture("first");
	await first.append(Buffer.alloc(20_000, 97));
	await first.finish(true);
	const second = runStore.createCapture("second");
	await assert.rejects(second.append(Buffer.alloc(20_000, 98)), (error: unknown) => (error as { kind?: string }).kind === "run-quota");
	const runReceipt = await second.finish(false);
	assert.equal(runReceipt.capturedBytes, COMMAND_OUTPUT_PREVIEW_BYTES * 2 - 20_000);
	assert.equal(runReceipt.outputComplete, false);

	const blockedParent = join(root, "not-a-directory");
	await writeFile(blockedParent, "file");
	const storageSecret = "cannot-persist-secret";
	const failedStore = new CommandOutputStore({ workspaceRoot: root, outputDirectory: join(blockedParent, "capture"), knownSecrets: [storageSecret] });
	const failedCapture = failedStore.createCapture("storage");
	await failedCapture.append(Buffer.from(`evidence ${storageSecret}`));
	const failedReceipt = await failedCapture.finish(true);
	assert.equal(failedReceipt.storageFailure, true);
	assert.equal(failedReceipt.outputId, undefined);
	assert.match(failedReceipt.output, /evidence \[REDACTED\]/);
	assert.doesNotMatch(failedReceipt.output, new RegExp(storageSecret));
	assert.equal(failedReceipt.outputComplete, false);
	const boundarySecret = `sk-${"A".repeat(20)}`;
	const boundaryStore = new CommandOutputStore({ workspaceRoot: root, outputDirectory: join(blockedParent, "boundary"), knownSecrets: [boundarySecret] });
	const boundaryCapture = boundaryStore.createCapture("boundary-secret");
	await boundaryCapture.append(Buffer.from(`${"x".repeat(4_092)} ${boundarySecret} end`));
	const boundaryReceipt = await boundaryCapture.finish(true);
	assert.doesNotMatch(boundaryReceipt.output, new RegExp(boundarySecret));

	const longFailure = failedStore.createCapture("long-storage");
	await assert.rejects(longFailure.append(Buffer.from(`${"H".repeat(4_096)}${"M".repeat(20_000)}unsafe-prefix\n${"T".repeat(12_274)}`)), /storage failed/i);
	const longReceipt = await longFailure.finish(false);
	assert.equal(longReceipt.storageFailure, true);
	assert.equal(longReceipt.output.slice(0, 4_096), "H".repeat(4_096));
	assert.match(longReceipt.output, new RegExp(`${"T".repeat(128)}\\n\\n\\[Capture stopped`));
	assert.doesNotMatch(longReceipt.output, /M{128}/);
	const crossingSecret = "crossing-storage-secret";
	const crossingStore = new CommandOutputStore({ workspaceRoot: root, outputDirectory: join(blockedParent, "crossing"), knownSecrets: [crossingSecret] });
	const crossingFailure = crossingStore.createCapture("crossing-secret");
	const afterSecret = Buffer.alloc(COMMAND_OUTPUT_TAIL_BYTES - Buffer.byteLength(crossingSecret) + 2, 84);
	await assert.rejects(crossingFailure.append(Buffer.concat([Buffer.alloc(20_000, 77), Buffer.from(crossingSecret), afterSecret])), /storage failed/i);
	const crossingReceipt = await crossingFailure.finish(false);
	assert.equal(crossingReceipt.storageFailure, true);
	assert.doesNotMatch(crossingReceipt.output, new RegExp(crossingSecret.slice(2)));
	const genericSecret = `sk-${"A".repeat(20)}`;
	const genericStore = new CommandOutputStore({ workspaceRoot: root, outputDirectory: join(blockedParent, "generic-crossing") });
	const genericFailure = genericStore.createCapture("generic-crossing");
	const genericAfter = Buffer.alloc(COMMAND_OUTPUT_TAIL_BYTES - Buffer.byteLength(genericSecret) + 2, 71);
	await assert.rejects(genericFailure.append(Buffer.concat([Buffer.alloc(20_000, 70), Buffer.from(genericSecret), genericAfter])), /storage failed/i);
	const genericReceipt = await genericFailure.finish(false);
	assert.doesNotMatch(genericReceipt.output, new RegExp(`-${"A".repeat(20)}`));
	assert.match(genericReceipt.output, /^F{128}/);
	const keySecret = "API_KEY=SUPERSECRETVALUE";
	const keyStore = new CommandOutputStore({ workspaceRoot: root, outputDirectory: join(blockedParent, "key-crossing") });
	const keyFailure = keyStore.createCapture("key-crossing");
	const keyAfter = Buffer.alloc(COMMAND_OUTPUT_TAIL_BYTES - Buffer.byteLength(keySecret) + 4, 81);
	await assert.rejects(keyFailure.append(Buffer.concat([Buffer.alloc(20_000, 80), Buffer.from(keySecret), keyAfter])), /storage failed/i);
	const keyReceipt = await keyFailure.finish(false);
	assert.doesNotMatch(keyReceipt.output, /PERSECRETVALUE/);
	const urlStore = new CommandOutputStore({ workspaceRoot: root, outputDirectory: join(blockedParent, "url-crossing") });
	const urlFailure = urlStore.createCapture("url-crossing");
	await assert.rejects(urlFailure.append(Buffer.from(`${"F".repeat(20_000)}https://${"u".repeat(800)}`)), /storage failed/i);
	await assert.rejects(urlFailure.append(Buffer.from(`${"u".repeat(300)}:LEAKME12345@host${"T".repeat(11_727)}`)), /storage failed/i);
	assert.doesNotMatch((await urlFailure.finish(false)).output, /LEAKME12345/);
	const utf8TailStore = new CommandOutputStore({ workspaceRoot: root, outputDirectory: join(blockedParent, "utf8-tail") });
	const utf8TailFailure = utf8TailStore.createCapture("utf8-tail");
	await assert.rejects(utf8TailFailure.append(Buffer.from(`${"H".repeat(19_999)}🙂${"T".repeat(12_285)}`)), /storage failed/i);
	const utf8TailReceipt = await utf8TailFailure.finish(false);
	assert.match(utf8TailReceipt.output, /^H{128}/);
	assert.match(utf8TailReceipt.output, new RegExp(`${"T".repeat(128)}\\n\\n\\[Capture stopped`));
	assert.doesNotMatch(utf8TailReceipt.output, /not valid UTF-8/);
	const expansionStore = new CommandOutputStore({ workspaceRoot: root, outputDirectory: join(blockedParent, "expansion"), knownSecrets: ["aaaa"] });
	const expansionFailure = expansionStore.createCapture("redaction-expansion");
	await expansionFailure.append(Buffer.from("aaaa".repeat(COMMAND_OUTPUT_PREVIEW_BYTES / 4)));
	const expansionReceipt = await expansionFailure.finish(true);
	assert.equal(expansionReceipt.storageFailure, true);
	assert.ok(expansionReceipt.omittedBytes > 0);
	assert.ok(Buffer.byteLength(expansionReceipt.output) <= COMMAND_OUTPUT_PREVIEW_BYTES + 512);
	assert.doesNotMatch(expansionReceipt.output, /aaaa/);

	const invalidStore = new CommandOutputStore({ workspaceRoot: root, outputDirectory: join(root, "invalid-capture") });
	const invalidCapture = invalidStore.createCapture("invalid-utf8");
	await invalidCapture.append(Buffer.from([0xff]));
	const invalidReceipt = await invalidCapture.finish(true);
	assert.equal(invalidReceipt.storageFailure, true);
	assert.equal(invalidReceipt.outputComplete, false);
	assert.equal(invalidReceipt.previewTruncated, true);
	assert.equal(invalidReceipt.omittedBytes, 1);
	assert.equal(invalidReceipt.outputId, undefined);
	assert.match(invalidReceipt.output, /not valid UTF-8/);
	assert.throws(() => new CommandOutputStore({ workspaceRoot: root, maxOutputs: 2_049 }), /1-2048/);
	assert.throws(() => new CommandOutputStore({ workspaceRoot: root }).createCapture("x".repeat(16 * 1024 + 1)), /1-16384 bytes/);
	assert.throws(() => new CommandOutputStore({ workspaceRoot: root, maxCommandBytes: COMMAND_OUTPUT_LIMIT_BYTES + 1 }), /16384-8388608/);
	assert.throws(() => new CommandOutputStore({ workspaceRoot: root, maxRunBytes: RUN_OUTPUT_LIMIT_BYTES + 1 }), /8388608-33554432/);
	const countStore = new CommandOutputStore({ workspaceRoot: root, outputDirectory: join(root, "count-capture"), maxOutputs: 1 });
	const firstCount = countStore.createCapture("first-count");
	await firstCount.append(Buffer.from("first"));
	assert.ok((await firstCount.finish(true)).outputId);
	const secondCount = countStore.createCapture("second-count");
	await secondCount.append(Buffer.from("second"));
	const countReceipt = await secondCount.finish(true);
	assert.equal(countReceipt.storageFailure, true);
	assert.equal(countReceipt.outputId, undefined);
});

test("partial ownership is fixed-width and output-count bounded", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-output-metadata-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new CommandOutputStore({ workspaceRoot: root, outputDirectory: join(root, "capture"), maxOutputs: 2 });
	await assert.rejects(store.beginPartial(`${randomUUID()}.partial`, "x".repeat(16 * 1024)), /Invalid output partial ownership/);
	const owner = createHash("sha256").update("producer").digest("hex");
	await store.beginPartial(`${randomUUID()}.partial`, owner);
	await store.beginPartial(`${randomUUID()}.partial`, owner);
	await assert.rejects(store.beginPartial(`${randomUUID()}.partial`, owner), /Run output count exceeds 2/);
	assert.ok(Buffer.byteLength(await readFile(store.manifestPath)) < 1024 * 1024);
});

test("failed partial cleanup retains ownership and bounded evidence", async (t) => {
	if (process.platform === "win32") { t.skip("POSIX directory permissions required"); return; }
	const root = await mkdtemp(join(tmpdir(), "codetonomy-output-partial-cleanup-"));
	const store = new CommandOutputStore({ workspaceRoot: root, outputDirectory: join(root, "capture") });
	t.after(async () => { await chmod(store.outputDirectory, 0o700).catch(() => undefined); await rm(root, { recursive: true, force: true }); });
	const capture = store.createCapture("partial-cleanup");
	const outputOwner = createHash("sha256").update("partial-cleanup").digest("hex");
	await capture.append(Buffer.alloc(COMMAND_OUTPUT_PREVIEW_BYTES + 1, 120));
	await chmod(store.outputDirectory, 0o500);
	const receipt = await capture.finish(true);
	assert.equal(receipt.storageFailure, true);
	assert.equal(receipt.capturedBytes, COMMAND_OUTPUT_PREVIEW_BYTES + 1);
	assert.match(receipt.output, /x{128}/);
	const manifest = JSON.parse(await readFile(store.manifestPath, "utf8"));
	assert.equal(manifest.partials[0]?.originCallId, outputOwner);
	await store.cleanupIfEmpty();
	assert.equal(JSON.parse(await readFile(store.manifestPath, "utf8")).partials[0]?.originCallId, outputOwner);
});

test("process capture stops at quota without inventing mutation risk", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-output-process-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "sandbox"), "process.stdout.write('q'.repeat(100000)); setInterval(() => {}, 1000);\n");
	const store = new CommandOutputStore({
		workspaceRoot: root,
		outputDirectory: join(root, "capture"),
		maxCommandBytes: COMMAND_OUTPUT_PREVIEW_BYTES,
		maxRunBytes: COMMAND_OUTPUT_PREVIEW_BYTES,
	});
	let details: Record<string, unknown> | undefined;
	await assert.rejects(
		runWorkspaceCommandTool(root, { sandboxBinary: process.execPath, commandSandboxMode: "read-only", outputStore: store }).execute("quota", { argv: ["ignored"], timeoutSeconds: 5 }),
		(error: unknown) => {
			details = (error as { details?: Record<string, unknown> }).details;
			return details?.resultKind === "failure" && details.mutationRisk === "none" && details.outputComplete === false;
		},
	);
	assert.equal(details?.capturedBytes, COMMAND_OUTPUT_PREVIEW_BYTES);
	assert.equal(details?.checkpointCount, 0);
	assert.doesNotMatch(String((details as { output?: string }).output), /effects may already have occurred/i);
	assert.equal((await readAll(store, String(details?.outputId))).length, COMMAND_OUTPUT_PREVIEW_BYTES);
});

test("Bash executions share one run quota and one resolvable output namespace", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-output-run-owner-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "evidence.txt"), "fixture");
	await writeFile(join(root, "sandbox"), "process.stdout.write('x'.repeat(20000));");
	const store = new CommandOutputStore({ workspaceRoot: root, outputDirectory: join(root, "capture"), maxCommandBytes: 20_000, maxRunBytes: 30_000 });
	const tool = bashTool(root, { sandboxBinary: process.execPath, commandSandboxMode: "read-only", outputStore: store });
	const first = await tool.execute("first", { command: "cat evidence.txt" });
	const outputId = String((first.details as Record<string, unknown>).outputId);
	assert.equal((await store.read(outputId, 0, 4)).text, "xxxx");
	await assert.rejects(tool.execute("second", { command: "cat evidence.txt" }), (error: unknown) => {
		const details = (error as { details?: Record<string, unknown> }).details;
		return details?.capturedBytes === 10_000 && details.outputComplete === false;
	});
});

test("process capture preserves the observed stdout and stderr arrival order", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-output-order-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "sandbox"), `
process.stdout.write("stdout-one", () => setTimeout(() => {
  process.stderr.write("stderr-two", () => setTimeout(() => process.stdout.write("stdout-three"), 10));
}, 10));
`);
	const store = new CommandOutputStore({ workspaceRoot: root, outputDirectory: join(root, "capture") });
	const result = await runWorkspaceCommandTool(root, { sandboxBinary: process.execPath, commandSandboxMode: "read-only", outputStore: store }).execute("ordered", { argv: ["ignored"] });
	assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", "stdout-onestderr-twostdout-three");
});

test("command results preserve raw output, bounded receipts, and timeout evidence", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-output-receipt-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "sandbox"), "process.stdout.write('  raw output\\n');");
	const receiptSecret = "receipt-secret-value";
	const store = new CommandOutputStore({ workspaceRoot: root, outputDirectory: join(root, "capture"), knownSecrets: [receiptSecret] });
	const tool = runWorkspaceCommandTool(root, { sandboxBinary: process.execPath, commandSandboxMode: "read-only", outputStore: store });
	const result = await tool.execute("raw", { argv: ["ignored"], cwd: "." });
	assert.equal(result.content[0]?.type === "text" ? result.content[0].text : undefined, "  raw output\n");
	assert.match(result.content[1]?.type === "text" ? result.content[1].text : "", /^\[Command receipt:/);
	assert.deepEqual((result.details as Record<string, unknown>).argv, ["ignored"]);
	await assert.rejects(tool.execute("preflight", { argv: ["ignored", receiptSecret], cwd: "missing" }), (error: unknown) => {
		const failure = error as { message?: string; details?: Record<string, unknown> };
		return failure.details?.cwd === "missing" && JSON.stringify(failure.details.argv) === `["ignored","${receiptSecret}"]`
			&& /Command receipt/.test(failure.message ?? "") && !failure.message?.includes(receiptSecret);
	});
	await writeFile(join(root, "sandbox"), "process.stdout.write('evidence before timeout'); setInterval(() => {}, 1000);");
	await assert.rejects(tool.execute("timeout", { argv: ["ignored"], timeoutSeconds: 1 }), (error: unknown) => {
		const failure = error as { message?: string; details?: Record<string, unknown> };
		return String(failure.details?.output).includes("evidence before timeout") && failure.details?.outputComplete === false && /Command receipt/.test(failure.message ?? "");
	});
	await assert.rejects(bashTool(root, { outputStore: store }).execute("escape", { command: "cat ../outside" }), (error: unknown) => {
		const failure = error as { message?: string; details?: Record<string, unknown> };
		return failure.details?.command === "cat ../outside" && failure.details?.parseStatus === "parse-fallback" && /Command receipt/.test(failure.message ?? "");
	});
});

test("saved-output reader reports exact continuation metadata and serializes concurrent reads", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-output-reader-tool-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new CommandOutputStore({ workspaceRoot: root, outputDirectory: join(root, "capture") });
	const capture = store.createCapture("reader-call");
	await capture.append(Buffer.from("0123456789"));
	const receipt = await capture.finish(true);
	const reader = readToolOutputTool(store);
	const [first, second] = await Promise.all([
		reader.execute("first", { outputId: receipt.outputId!, offset: 0, limit: 4 }),
		reader.execute("second", { outputId: receipt.outputId!, offset: 4, limit: 4 }),
	]);
	assert.match(first.content[0]?.type === "text" ? first.content[0].text : "", /0123[\s\S]*bytes 0-3 of 10[\s\S]*offset":4/);
	assert.match(second.content[0]?.type === "text" ? second.content[0].text : "", /4567[\s\S]*bytes 4-7 of 10[\s\S]*offset":8/);
	const last = await reader.execute("last", { outputId: receipt.outputId!, offset: 8, limit: 4 });
	assert.match(last.content[0]?.type === "text" ? last.content[0].text : "", /89[\s\S]*End of complete saved output at byte 10 of 10/);
});

test("command output reader rejects linked and replaced captures", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-output-tamper-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new CommandOutputStore({ workspaceRoot: root, outputDirectory: join(root, "capture") });
	const linked = await store.createCapture("linked");
	await linked.append(Buffer.from("linked output"));
	const linkedReceipt = await linked.finish(true);
	const linkedPath = join(store.outputDirectory, `${linkedReceipt.outputId}.output`);
	await t.test("hard link", async (subtest) => {
		try { await link(linkedPath, join(root, "second-link")); }
		catch (error) { subtest.skip(`Hard links unavailable: ${(error as NodeJS.ErrnoException).code ?? error}`); return; }
		await assert.rejects(store.read(linkedReceipt.outputId!, 0, 32), /Unknown, expired, or unavailable/);
	});

	const replaced = store.createCapture("replaced");
	await replaced.append(Buffer.from("original output"));
	const replacedReceipt = await replaced.finish(true);
	const replacedPath = join(store.outputDirectory, `${replacedReceipt.outputId}.output`);
	await chmod(replacedPath, 0o600);
	await unlink(replacedPath);
	await writeFile(replacedPath, "replacement");
	await assert.rejects(store.read(replacedReceipt.outputId!, 0, 32), /Unknown, expired, or unavailable/);

	const linkedTarget = join(root, "target");
	await writeFile(linkedTarget, "target");
	const symbolic = store.createCapture("symbolic");
	await symbolic.append(Buffer.from("symbolic output"));
	const symbolicReceipt = await symbolic.finish(true);
	const symbolicPath = join(store.outputDirectory, `${symbolicReceipt.outputId}.output`);
	await unlink(symbolicPath);
	try { await symlink(linkedTarget, symbolicPath); }
	catch (error) { t.diagnostic(`Symlink replacement unavailable: ${(error as NodeJS.ErrnoException).code ?? error}`); return; }
	await assert.rejects(store.read(symbolicReceipt.outputId!, 0, 32));
});

test("only a Windows sandbox logon failure before start is retried (#21, #16)", async () => {
	const { retryWindowsSandboxLaunch, WINDOWS_SANDBOX_LAUNCH_FAILURE } = await import("../packages/tools/src/index.ts");
	assert.ok(WINDOWS_SANDBOX_LAUNCH_FAILURE.test("windows sandbox failed: CreateProcessWithLogonW failed: 267\n"));
	assert.ok(WINDOWS_SANDBOX_LAUNCH_FAILURE.test("windows sandbox failed: CreateProcessWithLogonW failed: 5"));
	assert.ok(!WINDOWS_SANDBOX_LAUNCH_FAILURE.test("windows sandbox failed: CreateProcessWithLogonW failed: 2"));
	assert.ok(!WINDOWS_SANDBOX_LAUNCH_FAILURE.test("test output\nwindows sandbox failed: CreateProcessWithLogonW failed: 5"));
	const outcomes = ["windows sandbox failed: CreateProcessWithLogonW failed: 267", "windows sandbox failed: CreateProcessWithLogonW failed: 5", "ok"];
	let attempts = 0;
	const result = await retryWindowsSandboxLaunch(async () => outcomes[attempts++]!, (output) => WINDOWS_SANDBOX_LAUNCH_FAILURE.test(output));
	if (process.platform === "win32") {
		assert.equal(result, "ok");
		assert.equal(attempts, 3);
	} else {
		assert.equal(attempts, 1);
	}
	attempts = 0;
	await retryWindowsSandboxLaunch(async () => { attempts++; return "genuine command failure"; }, (output) => WINDOWS_SANDBOX_LAUNCH_FAILURE.test(output));
	assert.equal(attempts, 1);
});
