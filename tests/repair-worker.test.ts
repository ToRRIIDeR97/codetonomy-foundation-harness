import assert from "node:assert/strict";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { createHarness, type HarnessRunOptions, type RunSpendBudgetState } from "../packages/runtime/src/index.ts";
import {
	classifyRepairFailure,
	createRepairReceipt,
	parseRepairResponse,
	renderRepairReceipts,
	validateRepairProposal,
} from "../packages/runtime/src/repair-worker.ts";
import { inspectWorkspaceTool } from "../packages/tools/src/index.ts";
import type { HarnessEvent } from "../packages/contracts/src/index.ts";
import { skipWithoutSymlinks } from "./support/environment.ts";
import { tempDirFactory } from "./support/temp.ts";

// File-scoped, so a test's own cleanup (such as pruning saved output) still finds its workspace.
const temporary = tempDirFactory("repair-worker-");

function completion(request: number, output: { text: string } | { tool: string; arguments: unknown; raw?: string }, usage = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }): Response {
	const base = { id: `response-${request}`, object: "chat.completion.chunk", created: 1, model: "repair-model" };
	const delta = "tool" in output
		? { role: "assistant", tool_calls: [{ index: 0, id: `call-${request}`, type: "function", function: { name: output.tool, arguments: output.raw ?? JSON.stringify(output.arguments) } }] }
		: { role: "assistant", content: output.text };
	return new Response([
		{ ...base, choices: [{ index: 0, delta, finish_reason: null }] },
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool" in output ? "tool_calls" : "stop" }], usage },
	].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

function toolBatchCompletion(request: number, calls: Array<{ tool: string; arguments: unknown }>): Response {
	const base = { id: `response-${request}`, object: "chat.completion.chunk", created: 1, model: "repair-model" };
	return new Response([
		{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: calls.map((call, index) => ({ index, id: `call-${request}-${index}`, type: "function", function: { name: call.tool, arguments: JSON.stringify(call.arguments) } })) }, finish_reason: null }] },
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } },
	].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

async function runWorker(context: "compact" | "fork", mutation?: "during-worker" | "before-reissue", throughSymlink = false) {
	const root = await temporary();
	if (throughSymlink) {
		await writeFile(join(root, "b.txt"), "evidence");
		await symlink("b.txt", join(root, "a.txt"));
	} else await writeFile(join(root, "a.txt"), "evidence");
	const bodies: Array<Record<string, unknown>> = [];
	let request = 0;
	const options: HarnessRunOptions = {
		objective: "Read a.txt",
		workspaceRoot: root,
		traceDirectory: join(root, ".harness/runs"),
		permissionMode: "auto",
		toolSelection: "minimal",
		provider: "repair-provider",
		modelId: "repair-model",
		providerConfiguration: { id: "repair-provider", name: "Repair", kind: "openai-compatible", baseUrl: "https://repair.test/v1", apiKey: "test-key" },
		maxModelTurns: 4,
		maxOutputTokens: 256,
		providerRetryLimit: 0,
		repairWorker: { context },
		providerFetch: async (_input, init) => {
			request++;
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			bodies.push(body);
			if (request === 1) return completion(request, { tool: "inspect_workspace", arguments: { path: "a.txt", unsupported: true } });
			if (request === 2) {
				if (mutation === "during-worker") await writeFile(join(root, "a.txt"), "changed externally");
				const packetText = (body.messages as Array<{ content?: unknown }>).map(({ content }) => typeof content === "string" ? content : JSON.stringify(content)).find((content) => content.includes("<repair-packet>"))!;
				const packet = JSON.parse(packetText.match(/<repair-packet>\n(.+)\n<\/repair-packet>/s)![1]!) as { identity: { failureId: string } };
				return completion(request, { text: JSON.stringify({ kind: "propose", failureId: packet.identity.failureId, toolName: "inspect_workspace", arguments: { path: "a.txt" }, explanation: "Remove the unsupported field." }) });
			}
			if (request === 3 && mutation !== "during-worker") {
				if (mutation === "before-reissue") await writeFile(join(root, "a.txt"), "changed externally");
				return completion(request, { tool: "inspect_workspace", arguments: { path: "a.txt" } });
			}
			return completion(request, { text: "Read complete." });
		},
	};
	const result = await createHarness().run(options);
	const events = (await readFile(result.tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as HarnessEvent);
	return { result, events, bodies, requests: request };
}

test("stale worker proposals are discarded before the primary sees a receipt", async () => {
	const { result, events, bodies, requests } = await runWorker("compact", "during-worker");
	assert.equal(requests, 4);
	assert.equal(result.verification.passed, false);
	assert.ok(events.some(({ type, data }) => type === "repair.worker.completed" && data.disposition === "stale"));
	assert.ok(bodies.slice(2).every((body) => !JSON.stringify(body).includes("repair-proposal")));
});

test("a symlink revision follows its authorized in-workspace source", async (t) => {
	if (skipWithoutSymlinks(t)) return;
	const { result, events, bodies } = await runWorker("compact", "during-worker", true);
	assert.equal(result.verification.passed, false);
	assert.ok(events.some(({ type, data }) => type === "repair.worker.completed" && data.disposition === "stale"));
	assert.ok(bodies.slice(2).every((body) => !JSON.stringify(body).includes("repair-proposal")));
});

test("a proposal that becomes stale before reissue is blocked at dispatch", async () => {
	const { result, events, bodies, requests } = await runWorker("compact", "before-reissue");
	assert.equal(requests, 4);
	assert.equal(result.verification.passed, false);
	assert.equal(events.filter(({ type }) => type === "tool.started").length, 0);
	assert.ok(events.some(({ type, data }) => type === "tool.failed" && String(data.message).includes("source revision changed")));
	assert.ok(!events.some(({ type }) => type === "tool.failure.resolved"));
	assert.doesNotMatch(JSON.stringify(bodies[3]), /repair-proposal/);
});

test("cancelling a worker never hands a proposal to the primary", async () => {
	const root = await temporary();
	await writeFile(join(root, "a.txt"), "evidence");
	const controller = new AbortController();
	const events: HarnessEvent[] = [];
	let requests = 0;
	await assert.rejects(createHarness().run({
		objective: "Read a.txt",
		workspaceRoot: root,
		traceDirectory: join(root, ".harness/runs"),
		permissionMode: "auto",
		toolSelection: "minimal",
		provider: "repair-provider",
		modelId: "repair-model",
		providerConfiguration: { id: "repair-provider", name: "Repair", kind: "openai-compatible", baseUrl: "https://repair.test/v1", apiKey: "test-key" },
		maxModelTurns: 4,
		repairWorker: { context: "compact" },
		signal: controller.signal,
		observers: [(event) => { events.push(event); }],
		providerFetch: async () => {
			requests++;
			if (requests === 1) return completion(requests, { tool: "inspect_workspace", arguments: { path: "a.txt", unsupported: true } });
			controller.abort(new Error("worker cancelled"));
			return completion(requests, { text: "{}" });
		},
	}), /abort|cancel/i);
	assert.equal(requests, 2);
	assert.equal(events.filter(({ type }) => type === "repair.worker.started").length, 1);
	assert.equal(events.filter(({ type }) => type === "tool.started").length, 0);
	assert.ok(!events.some(({ type, data }) => type === "repair.worker.completed" && data.disposition === "proposed"));
});

test("batched failures are repaired one at a time in source order", async () => {
	const root = await temporary();
	await Promise.all([writeFile(join(root, "a.txt"), "a"), writeFile(join(root, "b.txt"), "b")]);
	const packets: Array<{ attempt: { arguments: { path: string } }; identity: { failureId: string } }> = [];
	let requests = 0;
	const result = await createHarness().run({
		objective: "Read a.txt and b.txt",
		workspaceRoot: root,
		traceDirectory: join(root, ".harness/runs"),
		permissionMode: "auto",
		toolSelection: "minimal",
		provider: "repair-provider",
		modelId: "repair-model",
		providerConfiguration: { id: "repair-provider", name: "Repair", kind: "openai-compatible", baseUrl: "https://repair.test/v1", apiKey: "test-key" },
		maxModelTurns: 6,
		repairWorker: { context: "compact" },
		providerRetryLimit: 0,
		providerFetch: async (_input, init) => {
			requests++;
			if (requests === 1) return toolBatchCompletion(requests, [
				{ tool: "inspect_workspace", arguments: { path: "a.txt", unsupported: true } },
				{ tool: "inspect_workspace", arguments: { path: "b.txt", unsupported: true } },
			]);
			const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: unknown }> };
			const packetText = body.messages?.map(({ content }) => typeof content === "string" ? content : JSON.stringify(content)).find((content) => content.includes("<repair-packet>"));
			if (packetText) {
				const packet = JSON.parse(packetText.match(/<repair-packet>\n(.+)\n<\/repair-packet>/s)![1]!) as typeof packets[number];
				packets.push(packet);
				return completion(requests, { text: JSON.stringify({ kind: "propose", failureId: packet.identity.failureId, toolName: "inspect_workspace", arguments: { path: packet.attempt.arguments.path }, explanation: "Remove the unsupported field." }) });
			}
			if (requests === 3) return completion(requests, { tool: "inspect_workspace", arguments: { path: "a.txt" } });
			if (requests === 5) return completion(requests, { tool: "inspect_workspace", arguments: { path: "b.txt" } });
			return completion(requests, { text: "Read complete." });
		},
	});
	assert.equal(result.verification.passed, true);
	assert.equal(requests, 6);
	assert.deepEqual(packets.map(({ attempt }) => attempt.arguments.path), ["a.txt", "b.txt"]);
});

test("the generation cap records every queued failure it drains", async () => {
	const root = await temporary();
	const paths = ["a.txt", "b.txt", "c.txt", "d.txt"];
	await Promise.all(paths.map((path) => writeFile(join(root, path), path)));
	const events: HarnessEvent[] = [];
	let requests = 0;
	await createHarness().run({
		objective: "Read a.txt, b.txt, c.txt, and d.txt",
		workspaceRoot: root,
		traceDirectory: join(root, ".harness/runs"),
		permissionMode: "auto",
		toolSelection: "minimal",
		provider: "repair-provider",
		modelId: "repair-model",
		providerConfiguration: { id: "repair-provider", name: "Repair", kind: "openai-compatible", baseUrl: "https://repair.test/v1", apiKey: "test-key" },
		maxModelTurns: 8,
		repairWorker: { context: "compact" },
		providerRetryLimit: 0,
		observers: [(event) => { events.push(event); }],
		providerFetch: async (_input, init) => {
			requests++;
			if (requests === 1) return toolBatchCompletion(requests, paths.map((path) => ({ tool: "inspect_workspace", arguments: { path, unsupported: true } })));
			const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: unknown }> };
			const packetText = body.messages?.map(({ content }) => typeof content === "string" ? content : JSON.stringify(content)).find((content) => content.includes("<repair-packet>"));
			if (packetText) {
				const packet = JSON.parse(packetText.match(/<repair-packet>\n(.+)\n<\/repair-packet>/s)![1]!) as { identity: { failureId: string }; attempt: { arguments: { path: string } } };
				return completion(requests, { text: JSON.stringify({ kind: "propose", failureId: packet.identity.failureId, toolName: "inspect_workspace", arguments: { path: packet.attempt.arguments.path }, explanation: "Remove the unsupported field." }) });
			}
			if (requests === 8) return completion(requests, { text: "Done." });
			const repairedPath = paths[Math.floor((requests - 3) / 2)];
			return repairedPath ? completion(requests, { tool: "inspect_workspace", arguments: { path: repairedPath } }) : completion(requests, { text: "Done." });
		},
	});
	assert.equal(requests, 8);
	assert.equal(events.filter(({ type }) => type === "repair.worker.started").length, 3);
	assert.equal(events.filter(({ type, data }) => type === "repair.worker.skipped" && data.reason === "run-worker-generation-limit").length, 1);
});

test("fork mode skips instead of compacting an oversized shared prefix", async () => {
	const root = await temporary();
	await Promise.all([writeFile(join(root, "large.txt"), "x".repeat(50_000)), writeFile(join(root, "a.txt"), "a")]);
	const events: HarnessEvent[] = [];
	let requests = 0;
	await createHarness().run({
		objective: "Read large.txt and a.txt",
		workspaceRoot: root,
		traceDirectory: join(root, ".harness/runs"),
		permissionMode: "auto",
		toolSelection: "minimal",
		provider: "repair-provider",
		modelId: "repair-model",
		providerConfiguration: {
			id: "repair-provider",
			name: "Repair",
			kind: "openai-compatible",
			baseUrl: "https://repair.test/v1",
			apiKey: "test-key",
			modelMetadata: { id: "repair-model", name: "Repair", api: "openai-completions", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 12_000, maxTokens: 1_024 },
		},
		maxModelTurns: 4,
		maxOutputTokens: 256,
		repairWorker: { context: "fork" },
		providerRetryLimit: 0,
		observers: [(event) => { events.push(event); }],
		providerFetch: async () => {
			requests++;
			if (requests === 1) return completion(requests, { tool: "inspect_workspace", arguments: { path: "large.txt" } });
			if (requests === 2) return completion(requests, { tool: "inspect_workspace", arguments: { path: "a.txt", unsupported: true } });
			return completion(requests, { text: "Done." });
		},
	});
	assert.ok(requests >= 3);
	assert.equal(events.filter(({ type }) => type === "repair.worker.started").length, 0);
	assert.ok(events.some(({ type, data }) => type === "repair.worker.skipped" && data.reason === "exact-fork-does-not-fit"));
});

test("the worker leaves room for a primary continuation and does not recurse", async () => {
	for (const maxModelTurns of [2, 4]) {
		const root = await temporary();
		await writeFile(join(root, "a.txt"), "evidence");
		const events: HarnessEvent[] = [];
		let requests = 0;
		await createHarness().run({
			objective: "Read a.txt",
			workspaceRoot: root,
			traceDirectory: join(root, `.harness/${maxModelTurns}`),
			permissionMode: "auto",
			toolSelection: "minimal",
			provider: "repair-provider",
			modelId: "repair-model",
			providerConfiguration: { id: "repair-provider", name: "Repair", kind: "openai-compatible", baseUrl: "https://repair.test/v1", apiKey: "test-key" },
			maxModelTurns,
			repairWorker: { context: "compact" },
			providerRetryLimit: 0,
			observers: [(event) => { events.push(event); }],
			providerFetch: async (_input, init) => {
				requests++;
				if (requests === 1 || maxModelTurns === 4 && requests === 3) return completion(requests, { tool: "inspect_workspace", arguments: { path: "a.txt", unsupported: true } });
				if (maxModelTurns === 4 && requests === 2) {
					const body = JSON.parse(String(init?.body)) as { messages: Array<{ content?: unknown }> };
					const packetText = body.messages.map(({ content }) => typeof content === "string" ? content : JSON.stringify(content)).find((content) => content.includes("<repair-packet>"))!;
					const failureId = (JSON.parse(packetText.match(/<repair-packet>\n(.+)\n<\/repair-packet>/s)![1]!) as { identity: { failureId: string } }).identity.failureId;
					return completion(requests, { text: JSON.stringify({ kind: "propose", failureId, toolName: "inspect_workspace", arguments: { path: "a.txt" }, explanation: "Remove the unsupported field." }) });
				}
				return completion(requests, { text: "Done." });
			},
		});
		if (maxModelTurns === 2) {
			assert.equal(requests, 2);
			assert.equal(events.filter(({ type }) => type === "repair.worker.started").length, 0);
			assert.ok(events.some(({ type, data }) => type === "repair.worker.skipped" && data.reason === "parent-continuation-model-turn-unavailable"));
		} else {
			assert.equal(requests, 4);
			assert.equal(events.filter(({ type }) => type === "repair.worker.started").length, 1);
			assert.ok(events.some(({ type, data }) => type === "repair.worker.skipped" && data.reason === "failure-fingerprint-already-attempted"));
		}
	}
});

test("the worker does not run after the last tool-call slot is consumed", async () => {
	const root = await temporary();
	await writeFile(join(root, "a.txt"), "evidence");
	const events: HarnessEvent[] = [];
	let requests = 0;
	await createHarness().run({
		objective: "Read a.txt",
		workspaceRoot: root,
		traceDirectory: join(root, ".harness/runs"),
		permissionMode: "auto",
		toolSelection: "minimal",
		provider: "repair-provider",
		modelId: "repair-model",
		providerConfiguration: { id: "repair-provider", name: "Repair", kind: "openai-compatible", baseUrl: "https://repair.test/v1", apiKey: "test-key" },
		maxModelTurns: 3,
		maxToolCalls: 1,
		repairWorker: { context: "compact" },
		providerRetryLimit: 0,
		observers: [(event) => { events.push(event); }],
		providerFetch: async () => completion(++requests, requests === 1 ? { tool: "inspect_workspace", arguments: { path: "a.txt", unsupported: true } } : { text: "Done." }),
	});
	assert.ok(requests >= 2);
	assert.equal(events.filter(({ type }) => type === "repair.worker.started").length, 0);
	assert.ok(events.some(({ type, data }) => type === "repair.worker.skipped" && data.reason === "parent-correction-tool-call-unavailable"));
});

test("an incomplete worker request retains its shared reservation", async () => {
	const root = await temporary();
	await writeFile(join(root, "a.txt"), "evidence");
	const spendBudgetState: RunSpendBudgetState = { maxTotalTokens: 100_000, costUsd: 0, totalTokens: 0 };
	const runBudgetState = { deadline: Date.now() + 60_000, modelTurns: 0, toolCalls: 0 };
	const events: HarnessEvent[] = [];
	let reservedDuringWorker: { modelTurns: number; toolCalls: number } | undefined;
	let requests = 0;
	await createHarness().run({
		objective: "Read a.txt",
		workspaceRoot: root,
		traceDirectory: join(root, ".harness/runs"),
		permissionMode: "auto",
		toolSelection: "minimal",
		provider: "repair-provider",
		modelId: "repair-model",
		providerConfiguration: { id: "repair-provider", name: "Repair", kind: "openai-compatible", baseUrl: "https://repair.test/v1", apiKey: "test-key" },
		maxModelTurns: 3,
		maxOutputTokens: 8_192,
		maxTotalTokens: spendBudgetState.maxTotalTokens,
		spendBudgetState,
		runBudgetState,
		repairWorker: { context: "compact" },
		providerRetryLimit: 0,
		observers: [(event) => { events.push(event); }],
		providerFetch: async () => {
			requests++;
			if (requests === 1) return completion(requests, { tool: "inspect_workspace", arguments: { path: "a.txt", unsupported: true } });
			if (requests === 2) {
				reservedDuringWorker = { modelTurns: runBudgetState.modelTurns, toolCalls: runBudgetState.toolCalls };
				return new Response("provider failed", { status: 500 });
			}
			return completion(requests, { text: "Done." });
		},
	});
	assert.equal(requests, 3);
	assert.deepEqual(reservedDuringWorker, { modelTurns: 3, toolCalls: 2 });
	assert.ok((spendBudgetState.reservedTokens ?? 0) > 0);
	assert.ok(events.some(({ type, data }) => type === "repair.worker.completed" && data.disposition === "provider-failure"));
});

test("an incomplete worker respects the explicit primary output ceiling", async () => {
	const root = await temporary();
	await writeFile(join(root, "a.txt"), "evidence");
	const outputCaps: number[] = [];
	let requests = 0;
	await createHarness().run({
		objective: "Read a.txt",
		workspaceRoot: root,
		traceDirectory: join(root, ".harness/runs"),
		permissionMode: "auto",
		toolSelection: "minimal",
		provider: "repair-provider",
		modelId: "repair-model",
		providerConfiguration: { id: "repair-provider", name: "Repair", kind: "openai-compatible", baseUrl: "https://repair.test/v1", apiKey: "test-key" },
		maxModelTurns: 3,
		maxOutputTokens: 8_192,
		repairWorker: { context: "compact" },
		providerRetryLimit: 0,
		providerFetch: async (_input, init) => {
			requests++;
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			outputCaps.push(Number(body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens));
			if (requests === 1) return completion(requests, { tool: "inspect_workspace", arguments: { path: "a.txt", unsupported: true } }, { prompt_tokens: 20, completion_tokens: 90_000, total_tokens: 90_020 });
			if (requests === 2) return new Response("provider failed", { status: 500 });
			return completion(requests, { text: "Done." });
		},
	});
	assert.equal(requests, 3);
	assert.equal(outputCaps[1], 2_048);
	assert.equal(outputCaps[2], 8_192);
});

test("a successful zero-usage worker keeps its shared spending reservation", async () => {
	const root = await temporary();
	await writeFile(join(root, "a.txt"), "evidence");
	const outputCaps: number[] = [];
	const spendBudgetState = { maxTotalTokens: 250_000, totalTokens: 0, costUsd: 0, reservedTokens: 0 };
	let requests = 0;
	await createHarness().run({
		objective: "Read a.txt",
		workspaceRoot: root,
		traceDirectory: join(root, ".harness/runs"),
		permissionMode: "auto",
		toolSelection: "minimal",
		provider: "repair-provider",
		modelId: "repair-model",
		providerConfiguration: { id: "repair-provider", name: "Repair", kind: "openai-compatible", baseUrl: "https://repair.test/v1", apiKey: "test-key" },
		maxModelTurns: 4,
		maxOutputTokens: 8_192,
		spendBudgetState,
		repairWorker: { context: "compact" },
		providerRetryLimit: 0,
		providerFetch: async (_input, init) => {
			requests++;
			const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { messages?: Array<{ content?: unknown }> };
			outputCaps.push(Number(body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens));
			if (requests === 1) return completion(requests, { tool: "inspect_workspace", arguments: { path: "a.txt", unsupported: true } }, { prompt_tokens: 20, completion_tokens: 90_000, total_tokens: 90_020 });
			if (requests === 2) {
				const packetText = body.messages?.map(({ content }) => typeof content === "string" ? content : JSON.stringify(content)).find((content) => content.includes("<repair-packet>"))!;
				const failureId = (JSON.parse(packetText.match(/<repair-packet>\n(.+)\n<\/repair-packet>/s)![1]!) as { identity: { failureId: string } }).identity.failureId;
				return completion(requests, { text: JSON.stringify({ kind: "propose", failureId, toolName: "inspect_workspace", arguments: { path: "a.txt" }, explanation: "Remove the unsupported field." }) }, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
			}
			if (requests === 3) return completion(requests, { tool: "inspect_workspace", arguments: { path: "a.txt" } });
			return completion(requests, { text: "Done." });
		},
	});
	assert.equal(requests, 4);
	assert.equal(outputCaps[2], 8_192);
	assert.equal(outputCaps[3], 8_192);
	assert.ok(spendBudgetState.reservedTokens > 0);
});

test("abstentions and invalid worker proposals return to the primary without dispatch", async () => {
	for (const item of [
		{ disposition: "abstain", response: (failureId: string) => ({ text: JSON.stringify({ kind: "abstain", failureId, reason: "No safe correction." }) }) },
		{ disposition: "needs-context", response: (failureId: string) => ({ text: JSON.stringify({ kind: "needs-context", failureId, reason: "More evidence is required." }) }) },
		{ disposition: "invalid", response: (failureId: string) => ({ text: JSON.stringify({ kind: "propose", failureId, toolName: "inspect_workspace", arguments: { path: "b.txt" }, explanation: "Change target." }) }) },
		{ disposition: "invalid", response: () => ({ tool: "inspect_workspace", arguments: { path: "a.txt" } }) },
	] as const) {
		const root = await temporary();
		await Promise.all([writeFile(join(root, "a.txt"), "a"), writeFile(join(root, "b.txt"), "b")]);
		const bodies: Array<Record<string, unknown>> = [];
		const events: HarnessEvent[] = [];
		let requests = 0;
		await createHarness().run({
			objective: "Read a.txt",
			workspaceRoot: root,
			traceDirectory: join(root, `.harness/${item.disposition}`),
			permissionMode: "auto",
			toolSelection: "minimal",
			provider: "repair-provider",
			modelId: "repair-model",
			providerConfiguration: { id: "repair-provider", name: "Repair", kind: "openai-compatible", baseUrl: "https://repair.test/v1", apiKey: "test-key" },
			maxModelTurns: 3,
			repairWorker: { context: "compact" },
			providerRetryLimit: 0,
			observers: [(event) => { events.push(event); }],
			providerFetch: async (_input, init) => {
				requests++;
				const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { messages?: Array<{ content?: unknown }> };
				bodies.push(body);
				if (requests === 1) return completion(requests, { tool: "inspect_workspace", arguments: { path: "a.txt", unsupported: true } });
				if (requests === 2) {
					const packetText = body.messages?.map(({ content }) => typeof content === "string" ? content : JSON.stringify(content)).find((content) => content.includes("<repair-packet>"))!;
					const failureId = (JSON.parse(packetText.match(/<repair-packet>\n(.+)\n<\/repair-packet>/s)![1]!) as { identity: { failureId: string } }).identity.failureId;
					return completion(requests, item.response(failureId));
				}
				return completion(requests, { text: "Done." });
			},
		});
		assert.equal(requests, 3);
		assert.equal(events.filter(({ type }) => type === "tool.started").length, 0);
		assert.ok(events.some(({ type, data }) => type === "repair.worker.completed" && data.disposition === item.disposition));
		assert.doesNotMatch(JSON.stringify(bodies[2]), /repair-proposal/);
	}
});

test("the persisted repair receipt redacts write payloads", async () => {
	const root = await temporary();
	const secret = "private repair payload";
	let requests = 0;
	const result = await createHarness().run({
		objective: "Write a.txt",
		workspaceRoot: root,
		traceDirectory: join(root, ".harness/runs"),
		permissionMode: "auto",
		toolSelection: "minimal",
		provider: "repair-provider",
		modelId: "repair-model",
		providerConfiguration: { id: "repair-provider", name: "Repair", kind: "openai-compatible", baseUrl: "https://repair.test/v1", apiKey: "test-key" },
		maxModelTurns: 3,
		repairWorker: { context: "compact" },
		providerRetryLimit: 0,
		providerFetch: async (_input, init) => {
			requests++;
			if (requests === 1) return completion(requests, { tool: "write_workspace", arguments: { path: "a.txt", content: secret, unsupported: true } });
			if (requests === 2) {
				const body = JSON.parse(String(init?.body)) as { messages: Array<{ content?: unknown }> };
				const packetText = body.messages.map(({ content }) => typeof content === "string" ? content : JSON.stringify(content)).find((content) => content.includes("<repair-packet>"))!;
				const failureId = (JSON.parse(packetText.match(/<repair-packet>\n(.+)\n<\/repair-packet>/s)![1]!) as { identity: { failureId: string } }).identity.failureId;
				return completion(requests, { text: JSON.stringify({ kind: "propose", failureId, toolName: "write_workspace", arguments: { path: "a.txt", content: secret }, explanation: `Remove ${secret}.` }) });
			}
			return completion(requests, { text: "Done." });
		},
	});
	const trace = await readFile(result.tracePath, "utf8");
	assert.equal(requests, 3);
	assert.doesNotMatch(trace, new RegExp(secret));
	assert.match(trace, /REDACTED/);
});

test("an oversized audit receipt cannot reach the primary or bind a proposal", async () => {
	const root = await temporary();
	// Sized so the model-facing receipt fits 12 KiB but the redacted audit receipt does not.
	const globs = ["<".repeat(950), "<".repeat(949)];
	const explanation = "test-key".repeat(64);
	const bodies: Array<Record<string, unknown>> = [];
	const events: HarnessEvent[] = [];
	let requests = 0;
	await createHarness().run({
		objective: "Search the workspace",
		workspaceRoot: root,
		traceDirectory: join(root, ".harness/runs"),
		permissionMode: "auto",
		presetId: "general-assistant",
		toolSelection: "preset",
		provider: "repair-provider",
		modelId: "repair-model",
		providerConfiguration: { id: "repair-provider", name: "Repair", kind: "openai-compatible", baseUrl: "https://repair.test/v1", apiKey: "test-key" },
		maxModelTurns: 3,
		repairWorker: { context: "compact" },
		providerRetryLimit: 0,
		observers: [(event) => { events.push(event); }],
		providerFetch: async (_input, init) => {
			requests++;
			const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { messages?: Array<{ content?: unknown }> };
			bodies.push(body);
			if (requests === 1) return completion(requests, { tool: "search_workspace", arguments: { query: "x", globs, unsupported: true } });
			if (requests === 2) {
				const packetText = body.messages?.map(({ content }) => typeof content === "string" ? content : JSON.stringify(content)).find((content) => content.includes("<repair-packet>"))!;
				const failureId = (JSON.parse(packetText.match(/<repair-packet>\n(.+)\n<\/repair-packet>/s)![1]!) as { identity: { failureId: string } }).identity.failureId;
				return completion(requests, { text: JSON.stringify({ kind: "propose", failureId, toolName: "search_workspace", arguments: { query: "x", globs }, explanation }) });
			}
			return completion(requests, { text: "Done." });
		},
	});
	assert.equal(requests, 3);
	assert.ok(events.some(({ type, data }) => type === "repair.worker.completed" && data.disposition === "invalid" && data.reason === "proposal-audit-receipt-too-large"));
	assert.doesNotMatch(JSON.stringify(bodies[2]), /repair-proposal/);
	assert.equal(events.filter(({ type }) => type === "tool.started").length, 0);
	assert.ok(!events.some(({ type }) => type === "tool.failure.resolved"));
});

test("disabled, malformed, and denied failures do not dispatch a worker", async () => {
	const root = await temporary();
	await writeFile(join(root, "a.txt"), "evidence");
	for (const item of [
		{ repairWorker: undefined, permissionMode: "auto" as const, toolInterface: "structured" as const, call: { tool: "inspect_workspace", arguments: { path: "a.txt", unsupported: true } } },
		{ repairWorker: { context: "compact" as const }, permissionMode: "auto" as const, toolInterface: "structured" as const, call: { tool: "inspect_workspace", arguments: null, raw: '{"path":"a.txt"' } },
		{ repairWorker: { context: "compact" as const }, permissionMode: "ask" as const, toolInterface: "structured" as const, call: { tool: "write_workspace", arguments: { path: "a.txt", content: "changed" } } },
	]) {
		let requests = 0;
		const events: HarnessEvent[] = [];
		await createHarness().run({
			objective: item.call.tool === "write_workspace" ? "Update a.txt" : "Read a.txt",
			workspaceRoot: root,
			traceDirectory: join(root, `.harness/${requests}-${item.call.tool}`),
			permissionMode: item.permissionMode,
			toolInterface: item.toolInterface,
			toolSelection: "minimal",
			provider: "repair-provider",
			modelId: "repair-model",
			providerConfiguration: { id: "repair-provider", name: "Repair", kind: "openai-compatible", baseUrl: "https://repair.test/v1", apiKey: "test-key" },
			maxModelTurns: 2,
			repairWorker: item.repairWorker,
			observers: [(event) => { events.push(event); }],
			approve: async () => false,
			providerFetch: async () => completion(++requests, requests === 1 ? item.call : { text: "Done." }),
		});
		assert.equal(requests, item.call.tool === "write_workspace" ? 1 : 2);
		assert.equal(events.filter(({ type }) => type === "repair.worker.started").length, 0);
	}
});

test("native schema repair consumes authoritative command outcome metadata", async () => {
	const root = await temporary();
	const events: HarnessEvent[] = [];
	let requests = 0;
	await createHarness().run({
		objective: "List the workspace",
		workspaceRoot: root,
		traceDirectory: join(root, ".harness/runs"),
		permissionMode: "full-access",
		toolInterface: "bash",
		toolSelection: "minimal",
		provider: "repair-provider",
		modelId: "repair-model",
		providerConfiguration: { id: "repair-provider", name: "Repair", kind: "openai-compatible", baseUrl: "https://repair.test/v1", apiKey: "test-key" },
		maxModelTurns: 4,
		repairWorker: { context: "compact" },
		providerRetryLimit: 0,
		observers: [(event) => { events.push(event); }],
		providerFetch: async (_input, init) => {
			requests++;
			if (requests === 1) return completion(requests, { tool: "bash", arguments: { command: "ls", unsupported: true } });
			if (requests === 2) {
				const body = JSON.parse(String(init?.body)) as { messages: Array<{ content?: unknown }> };
				const packetText = body.messages.map(({ content }) => typeof content === "string" ? content : JSON.stringify(content)).find((content) => content.includes("<repair-packet>"))!;
				const failureId = (JSON.parse(packetText.match(/<repair-packet>\n(.+)\n<\/repair-packet>/s)![1]!) as { identity: { failureId: string } }).identity.failureId;
				return completion(requests, { text: JSON.stringify({ kind: "propose", failureId, toolName: "bash", arguments: { command: "ls" }, explanation: "Remove the unsupported field." }) });
			}
			if (requests === 3) return completion(requests, { tool: "bash", arguments: { command: "ls" } });
			return completion(requests, { text: "Done." });
		},
	});
	const failure = events.find(({ type }) => type === "tool.failed");
	assert.equal(requests, 4);
	assert.equal(failure?.data.resultKind, "failure");
	assert.equal(failure?.data.mutationRisk, "none");
	assert.equal(failure?.data.workerRepairEligible, true);
	assert.equal(events.filter(({ type }) => type === "repair.worker.started").length, 1);
	assert.equal(events.filter(({ type }) => type === "tool.started").length, 1);
	assert.ok(events.some(({ type, data }) => type === "tool.failure.resolved" && data.repairClass === "worker-correction"), JSON.stringify(events));
});

test("an invalid call through a workspace link escape is not repairable", async (t) => {
	if (skipWithoutSymlinks(t)) return;
	const [root, outside] = await Promise.all([temporary(), temporary()]);
	await writeFile(join(outside, "outside.txt"), "private");
	await symlink(join(outside, "outside.txt"), join(root, "escape.txt"));
	const events: HarnessEvent[] = [];
	let requests = 0;
	await createHarness().run({
		objective: "Read escape.txt",
		workspaceRoot: root,
		traceDirectory: join(root, ".harness/runs"),
		permissionMode: "auto",
		toolSelection: "minimal",
		provider: "repair-provider",
		modelId: "repair-model",
		providerConfiguration: { id: "repair-provider", name: "Repair", kind: "openai-compatible", baseUrl: "https://repair.test/v1", apiKey: "test-key" },
		maxModelTurns: 2,
		repairWorker: { context: "compact" },
		observers: [(event) => { events.push(event); }],
		providerFetch: async () => completion(++requests, requests === 1 ? { tool: "inspect_workspace", arguments: { path: "escape.txt", unsupported: true } } : { text: "Done." }),
	});
	assert.equal(requests, 2);
	assert.equal(events.filter(({ type }) => type === "repair.worker.started").length, 0);
	assert.ok(events.some(({ type, data }) => type === "tool.failed" && data.workerRepairReason === "permission-or-policy-denial"));
});

test("repair response and proposal validation reject identity, target, intent, and extra response fields", () => {
	assert.equal(parseRepairResponse('{"kind":"abstain","failureId":"f","reason":"No safe correction"}', "f", "inspect_workspace").kind, "abstain");
	assert.equal(parseRepairResponse('{"kind":"abstain","failureId":"wrong","reason":"No","extra":1}', "f", "inspect_workspace").kind, "invalid");
	const tool = inspectWorkspaceTool("/workspace");
	assert.equal(validateRepairProposal({ tool, callId: "f", originalArguments: { path: "a.txt", extra: true }, proposedArguments: { path: "a.txt" }, originalTarget: "/workspace/a.txt", targetOf: (args) => typeof (args as { path?: unknown })?.path === "string" ? `/workspace/${(args as { path: string }).path}` : undefined }).valid, true);
	assert.equal(validateRepairProposal({ tool, callId: "f", originalArguments: { path: "a.txt", extra: true }, proposedArguments: { path: "b.txt" }, originalTarget: "/workspace/a.txt", targetOf: (args) => typeof (args as { path?: unknown })?.path === "string" ? `/workspace/${(args as { path: string }).path}` : undefined }).valid, false);
	assert.equal(validateRepairProposal({ tool, callId: "f", originalArguments: { path: "a.txt" }, proposedArguments: { path: "a.txt", limit: 20 }, originalTarget: "/workspace/a.txt", targetOf: (args) => typeof (args as { path?: unknown })?.path === "string" ? `/workspace/${(args as { path: string }).path}` : undefined }).valid, false);
	const extensibleTool = { ...tool, parameters: { ...tool.parameters, additionalProperties: true } } as unknown as AgentTool;
	assert.equal(validateRepairProposal({ tool: extensibleTool, callId: "f", originalArguments: { path: "a.txt", extension: "kept" }, proposedArguments: { path: "a.txt", extension: "changed" }, originalTarget: "/workspace/a.txt", targetOf: (args) => `/workspace/${(args as { path: string }).path}` }).valid, false);
	assert.equal(classifyRepairFailure({ knownTool: true, truncated: false, blocked: false, cancelled: false, toolName: "bash", operationId: "run_workspace_command", executionOutcome: "rejected-before-start", resultKind: "failure", mutationRisk: "none", schemaValid: false }).eligible, true);
	assert.equal(classifyRepairFailure({ knownTool: true, truncated: false, blocked: false, cancelled: false, toolName: "bash", operationId: "run_workspace_command", executionOutcome: "rejected-before-start", resultKind: "no-matches", mutationRisk: "none", schemaValid: false }).eligible, false);
	assert.equal(classifyRepairFailure({ knownTool: true, truncated: false, blocked: false, cancelled: false, toolName: "bash", operationId: "run_workspace_command", executionOutcome: "rejected-before-start", resultKind: "failure", mutationRisk: "possible", schemaValid: false }).eligible, false);
	assert.equal(classifyRepairFailure({ knownTool: true, parseStatus: "invalid", truncated: false, blocked: false, cancelled: false, toolName: "inspect_workspace", operationId: "inspect_workspace", executionOutcome: "rejected-before-start", schemaValid: false }).eligible, false);
	assert.equal(classifyRepairFailure({ knownTool: true, truncated: false, blocked: false, cancelled: false, toolName: "inspect_workspace", operationId: "inspect_workspace", executionOutcome: "rejected-before-start", schemaValid: false }).eligible, true);
	assert.equal(classifyRepairFailure({ knownTool: true, truncated: false, blocked: false, cancelled: false, toolName: "inspect_workspace", operationId: "inspect_workspace", executionOutcome: "rejected-before-start", schemaValid: true }).eligible, false);
	assert.equal(classifyRepairFailure({ knownTool: true, truncated: false, blocked: false, cancelled: false, toolName: "inspect_workspace", operationId: "inspect_workspace", executionOutcome: "rejected-before-start", schemaValid: true }).reason, "semantic-repair-not-supported");
});

test("receipt projection is immutable and idempotent", () => {
	const message: AgentMessage = { role: "toolResult", toolCallId: "call", toolName: "inspect_workspace", content: [{ type: "text", text: "Original failure" }], isError: true, timestamp: 1 };
	const receipt = createRepairReceipt({ failureId: "call", callId: "call", toolName: "inspect_workspace", arguments: { path: "a.txt" }, explanation: "Remove the extra field." });
	const first = renderRepairReceipts([message], [receipt]);
	const second = renderRepairReceipts(first, [receipt]);
	assert.notEqual(first[0], message);
	assert.equal(message.role === "toolResult" && message.content.length, 1);
	assert.deepEqual(second, first);
	assert.throws(() => createRepairReceipt({ failureId: "call", callId: "call", toolName: "inspect_workspace", arguments: { path: "<".repeat(3_000) }, explanation: "Remove the extra field." }), /12 KiB/);
});

test("proposal validation runs a tool's prepareArguments before the exact schema", () => {
	const tool = { ...inspectWorkspaceTool("/workspace"), prepareArguments: (args: unknown) => ({ ...(args as { path: string }), path: (args as { path: string }).path === "ALIAS" ? "a.txt" : (args as { path: string }).path }) } as unknown as AgentTool;
	assert.equal(validateRepairProposal({ tool, callId: "f", originalArguments: { path: "a.txt" }, proposedArguments: { path: "ALIAS" }, originalTarget: "/workspace/a.txt", targetOf: (args) => `/workspace/${(args as { path: string }).path}` }).valid, true);
});

test("primary-only schema recovery binds the raw Bash rejection to its successful correction", async () => {
 const root = await temporary();
 await writeFile(join(root, "sample.txt"), "hello\n");
 let requests = 0;
 const result = await createHarness().run({
  objective: 'Inspect sample.txt. First use Bash with command argument exactly cat sample.txt. If a schema error occurs, reissue that call with corrected arguments before proceeding. Return only {"ok":true} if sample.txt contains hello. Do not edit files.',
  workspaceRoot: root, traceDirectory: join(root, ".harness/runs"), permissionMode: "auto", toolInterface: "bash", maxModelTurns: 6,
  provider: "repair-provider", modelId: "repair-model", providerRetryLimit: 0,
  providerConfiguration: { id: "repair-provider", name: "Repair", kind: "openai-compatible", baseUrl: "https://repair.test/v1", apiKey: "test-key" },
  providerFetch: async () => completion(++requests, requests === 1 ? { tool: "bash", arguments: { command: "cat sample.txt", unsupported: true } } : requests === 2 ? { tool: "bash", arguments: { command: "cat sample.txt" } } : { text: '{"ok":true}' }),
 });
 assert.deepEqual(JSON.parse(result.output), { ok: true });
 assert.equal(result.verification.passed, true, JSON.stringify(result.verification));
 const events = (await readFile(result.tracePath, "utf8")).trim().split("\n").map(line => JSON.parse(line) as HarnessEvent);
 assert.equal(events.filter(e => e.type === "repair.worker.started").length, 0);
 assert.equal(events.filter(e => e.type === "tool.failure.resolved" && e.data.repairClass === "model-correction").length, 1);
 assert.equal(requests, 3);
});

test("primary schema correction does not clear unrelated Bash failures in a batch", async () => {
 for (const corrected of ["cat a.txt", "cat b.txt", "head a.txt"]) {
  const root = await temporary();
  await writeFile(join(root, "a.txt"), "a");
  await writeFile(join(root, "b.txt"), "b");
  let requests = 0;
  const result = await createHarness().run({
   objective: "Inspect the workspace. Do not edit files.", workspaceRoot: root, traceDirectory: join(root, ".harness/runs"),
   permissionMode: "auto", toolInterface: "bash", provider: "repair-provider", modelId: "repair-model", maxModelTurns: 4, providerRetryLimit: 0,
   providerConfiguration: { id: "repair-provider", name: "Repair", kind: "openai-compatible", baseUrl: "https://repair.test/v1", apiKey: "test-key" },
   providerFetch: async () => {
    requests++;
    if (requests === 1) return toolBatchCompletion(requests, [
     { tool: "bash", arguments: { command: "cat a.txt", unsupported: true } },
     { tool: "bash", arguments: { command: "cat b.txt", unsupported: true } },
    ]);
    return completion(requests, requests === 2 ? { tool: "bash", arguments: { command: corrected } } : { text: "Inspected." });
   },
  });
  const events = (await readFile(result.tracePath, "utf8")).trim().split("\n").map(line => JSON.parse(line) as HarnessEvent);
  const resolutions = events.filter(e => e.type === "tool.failure.resolved");
  // The correction resolves only its own call. The unrelated call never started, so since #14 it is
  // superseded (not resolved) once required evidence is complete, and no longer fails the run.
  assert.equal(resolutions.length, corrected.startsWith("cat") ? 1 : 0);
  if (resolutions.length) assert.equal(resolutions[0]!.data.originatingCallId, corrected === "cat a.txt" ? "call-1-0" : "call-1-1");
  const superseded = events.filter(e => e.type === "tool.failure.superseded");
  assert.equal(superseded.length, 2 - resolutions.length);
  assert.ok(superseded.every(e => e.data.reason === "Rejected before start; required evidence is complete"));
  assert.equal(result.verification.passed, true, JSON.stringify(result.verification.checks.filter(c => !c.passed)));
  assert.equal(events.filter(e => e.type === "repair.worker.started").length, 0);
 }
});

test("compact and fork preserve worker attribution for the same corrected Bash read", async () => {
 for (const context of ["compact", "fork"] as const) {
  const root = await temporary();
  await writeFile(join(root, "sample.txt"), "hello\n");
  let primary = 0, worker = 0, requests = 0;
  const result = await createHarness().run({
   objective: "Read sample.txt. Do not edit files.", workspaceRoot: root, traceDirectory: join(root, ".harness/runs"),
   permissionMode: "auto", toolInterface: "bash", provider: "repair-provider", modelId: "repair-model", maxModelTurns: 6, providerRetryLimit: 0,
   repairWorker: { context }, providerConfiguration: { id: "repair-provider", name: "Repair", kind: "openai-compatible", baseUrl: "https://repair.test/v1", apiKey: "test-key" },
   providerFetch: async (_input, init) => {
    requests++;
    const body = JSON.parse(String(init?.body));
    const packetText = body.messages.map((m: {content: unknown}) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).find((text: string) => text.includes("<repair-packet>"));
    if (packetText) {
     worker++;
     const packet = JSON.parse(packetText.match(/<repair-packet>\n(.+)\n<\/repair-packet>/s)[1]);
     return completion(requests, { text: JSON.stringify({ kind: "propose", failureId: packet.identity.failureId, toolName: "bash", arguments: { command: "cat sample.txt" }, explanation: "Remove the unsupported field." }) });
    }
    primary++;
    return completion(requests, primary === 1 ? { tool: "bash", arguments: { command: "cat sample.txt", unsupported: true } } : primary === 2 ? { tool: "bash", arguments: { command: "cat sample.txt" } } : { text: "hello" });
   },
  });
  assert.equal(result.verification.passed, true, JSON.stringify(result.verification));
  assert.deepEqual({ primary, worker }, { primary: 3, worker: 1 });
  const events = (await readFile(result.tracePath, "utf8")).trim().split("\n").map(line => JSON.parse(line) as HarnessEvent);
  assert.equal(events.filter(e => e.type === "tool.failure.resolved" && e.data.repairClass === "worker-correction").length, 1);
 }
});
