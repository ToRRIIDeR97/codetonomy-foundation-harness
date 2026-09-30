import { createHash } from "node:crypto";
import type { Context, Message, Model, Api } from "@earendil-works/pi-ai";

export interface RunSpendBudgetState {
	maxCostUsd?: number;
	maxTotalTokens?: number;
	costUsd: number;
	totalTokens: number;
	reservedCostUsd?: number;
	reservedTokens?: number;
}

export interface Reservation { inputTokens: number; outputTokens: number; tokens: number; costUsd: number }

export class RequestAdmissionError extends Error {
 constructor(readonly kind: "cost" | "tokens" | "context", message: string, readonly details: Record<string, number> = {}) { super(message); this.name = "RequestAdmissionError"; }
}

const RETAINED_RESULT_FIELDS = new Set([
	"resultKind", "mutationRisk", "executionOutcome", "exitCode", "capturedBytes", "readableBytes", "previewTruncated", "omittedBytes", "outputComplete", "outputId", "complete", "eof",
	"path", "paths", "sourceRefs", "offset", "limit", "nextOffset", "totalBytes", "totalLines", "matches", "backend", "sourceHash", "contentHash", "operationId", "parseStatus", "planReason",
	"testName", "sourceLocation", "expected", "actual", "evidenceId", "exitStatus", "truncated",
]);
const EXACT_RESULT_FIELDS = new Set(["path", "outputId", "sourceHash", "contentHash", "evidenceId"]);

const compactResultDetails = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object") return {};
	const compact: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (!RETAINED_RESULT_FIELDS.has(key)) continue;
		if (typeof item === "string") compact[key] = EXACT_RESULT_FIELDS.has(key) ? item : item.slice(0, 512);
		else if (typeof item === "number" || typeof item === "boolean" || item === null) compact[key] = item;
		else if (Array.isArray(item) && item.every((entry) => ["string", "number", "boolean"].includes(typeof entry))) compact[key] = item.slice(0, 16);
		else if (key === "sourceRefs" && Array.isArray(item)) compact[key] = item.slice(0, 16).flatMap((entry) => entry && typeof entry === "object"
			&& typeof (entry as Record<string, unknown>).path === "string" && typeof (entry as Record<string, unknown>).sourceHash === "string"
			? [{ path: (entry as Record<string, unknown>).path, sourceHash: (entry as Record<string, unknown>).sourceHash }] : []);
	}
	return compact;
};

const resultExcerpt = (content: unknown): string => {
	if (!Array.isArray(content)) return "";
	const text = content.flatMap((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string" ? [(item as { text: string }).text] : []).join("\n");
	if (text.length <= 800) return text;
	return `${text.slice(0, 400)}\n[…excerpt omitted…]\n${text.slice(-400)}`;
};

const workspacePath = (value: unknown): string | undefined =>
	typeof value === "string" && value ? value.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "") : undefined;

/** Identity of a successful whole-file or ranged read, or undefined when not a plain read. */
const readIdentity = (message: Message): { path: string; key: string } | undefined => {
	if (message.role !== "toolResult" || message.isError) return undefined;
	const details = (message.details ?? {}) as Record<string, unknown>;
	if (message.toolName === "inspect_workspace") {
		const path = workspacePath(details.path);
		return path ? { path, key: JSON.stringify(["inspect_workspace", path, details.offset ?? 1, details.limit ?? null]) } : undefined;
	}
	// Bash paths are workspace-relative only when the command ran at the root.
	if (message.toolName === "bash" && details.semanticOperationId === "inspect_workspace" && (details.cwd ?? ".") === "."
		&& Array.isArray(details.paths) && details.paths.length === 1 && Array.isArray(details.semanticArgv)) {
		const path = workspacePath(details.paths[0]);
		return path ? { path, key: JSON.stringify(["bash", details.semanticArgv]) } : undefined;
	}
	return undefined;
};

const writtenPath = (message: Message): string | undefined =>
	message.role === "toolResult" && !message.isError && ["write_workspace", "edit_workspace"].includes(message.toolName)
		? workspacePath((message.details as Record<string, unknown> | undefined)?.path) : undefined;

/**
 * Reads whose content is stale: the same read ran again later, or the file was
 * later written through write_workspace/edit_workspace. Bash writes are not
 * tracked, so a read they invalidate is simply not reported here.
 */
export const supersededReadIndexes = (messages: readonly Message[]): number[] => {
	const laterReads = new Set<string>();
	const laterWrites = new Set<string>();
	const superseded: number[] = [];
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		const written = writtenPath(message);
		if (written) { laterWrites.add(written); continue; }
		const read = readIdentity(message);
		if (!read) continue;
		if (laterReads.has(read.key) || laterWrites.has(read.path)) superseded.push(index);
		laterReads.add(read.key);
	}
	return superseded.reverse();
};

/** Context estimate, not a billing bound or a tokenizer. Excludes local metadata
 * and image base64. Keep spend admission on actual wire bytes below. */
export const estimateRequestTokens = (context: Context): number => {
	const textTokens = (text: string): number => {
		const ascii = text.match(/[\x00-\x7f]/g)?.length ?? 0;
		return Math.ceil(ascii / 3) + Buffer.byteLength(text) - ascii;
	};
	let tokens = 1024 + textTokens(context.systemPrompt ?? "") + textTokens(JSON.stringify(context.tools ?? []));
	for (const message of context.messages) {
		tokens += 16;
		if (typeof message.content === "string") tokens += textTokens(message.content);
		else for (const block of message.content) {
			if (block.type === "text") tokens += textTokens(block.text);
			else if (block.type === "thinking") tokens += textTokens(block.thinking);
			else if (block.type === "toolCall") tokens += textTokens(block.name + JSON.stringify(block.arguments));
			else if (block.type === "image") tokens += 8192;
		}
	}
	return tokens;
};

export function prepareRequest(context: Context, model: Pick<Model<Api>, "contextWindow" | "maxTokens">, requestedOutput: number, retained = new Map<string, Message>(), countTokens = estimateRequestTokens, retentionTokens = 262_144, historicalReasoningBilled = true) {
	if (!Number.isSafeInteger(retentionTokens) || retentionTokens < 4096) throw new Error("Context retention must be at least 4096 tokens");
	const estimate = (value: Context) => {
		const count = countTokens(value);
		if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid context token estimate");
		return count;
	};
	const keys = context.messages.map(message => message.role !== "user" ? createHash("sha256").update(JSON.stringify(message)).digest("hex") : "");
	const projected = { ...context, messages: context.messages.map((message, index) => retained.get(keys[index]!) ?? message) };
	// Some providers drop reasoning from turns before the latest user message
	// server-side. Count only what is billed; the wire payload is unchanged.
	const lastUser = context.messages.findLastIndex(message => message.role === "user");
	const billable = (message: Message, index: number): Message => historicalReasoningBilled || index >= lastUser || message.role !== "assistant"
		|| !message.content.some(block => block.type === "thinking") ? message : { ...message, content: message.content.filter(block => block.type !== "thinking") };
	const estimateProjected = () => estimate(historicalReasoningBilled ? projected : { ...projected, messages: projected.messages.map(billable) });
	let projectedTokens = estimateProjected();
	const replaceMessage = (index: number, message: Message) => {
		// The built-in estimate is additive; avoid re-tokenizing the whole session
		// for every compacted message. Custom counters may account for framing.
		const delta = countTokens === estimateRequestTokens ? estimate({ messages: [billable(message, index)] }) - estimate({ messages: [billable(projected.messages[index]!, index)] }) : undefined;
		projected.messages[index] = message;
		projectedTokens = delta === undefined ? estimateProjected() : projectedTokens + delta;
	};
	const maximumOutput = Math.min(requestedOutput, model.maxTokens, Math.max(1, model.contextWindow - projectedTokens));
	const hardInputLimit = model.contextWindow - maximumOutput;
	const pressure = projectedTokens > hardInputLimit;
	const retentionTriggered = projectedTokens > retentionTokens;
	const inputLimit = Math.min(hardInputLimit, retentionTriggered ? Math.floor(retentionTokens * 0.75) : hardInputLimit);
	// Leave recent work intact under the cost policy. Physical context pressure may
	// compact it too. A soft threshold never discards instructions to hit a number.
	let recentStart = projected.messages.length;
	let recentTokens = 0;
	const emptyTokens = estimate({ messages: [] });
	while (recentStart > 0 && recentTokens < Math.min(16_384, Math.floor(retentionTokens / 4))) {
		recentStart--;
		recentTokens += Math.max(0, estimate({ messages: [billable(projected.messages[recentStart]!, recentStart)] }) - emptyTokens);
	}
	const completedCalls = new Set(projected.messages.flatMap(message => message.role === "toolResult" && !message.isError ? [message.toolCallId] : []));
	const compactedResultSummaries = new Map<number, string>();
	let omittedResults = 0;
	let compactedArguments = 0;
	const compactResult = (index: number): void => {
		const message = projected.messages[index]!;
		if (message.role !== "toolResult") return;
		if ((message.details as { harnessCompacted?: boolean } | undefined)?.harnessCompacted) return;
		const serialized = JSON.stringify(message.content);
		const digest = createHash("sha256").update(serialized).digest("hex").slice(0, 16);
		const details = compactResultDetails((message as { details?: unknown }).details);
		const recoveryOffset = typeof details.offset === "number" && Number.isSafeInteger(details.offset) && details.offset >= 0 ? details.offset : 0;
		const recovery = [
			typeof details.outputId === "string" ? ` Recover omitted command bytes with read_tool_output({"outputId":${JSON.stringify(details.outputId)},"offset":${recoveryOffset},"limit":16384}); do not rerun the command for output recovery.` : "",
			typeof details.path === "string" || Array.isArray(details.paths) || Array.isArray(details.sourceRefs) ? " This is historical source evidence; reread the path after any file change." : "",
		].join("");
		const excerpt = resultExcerpt(message.content);
		const retainedError = message.isError && excerpt ? ` Error: ${excerpt}` : "";
		const summary = `Earlier ${message.toolName} result compacted (call ${JSON.stringify(message.toolCallId)}, sha256 ${digest}). Metadata: ${JSON.stringify(details)}.${recovery}${retainedError}`;
		const text = `${summary}${!message.isError && excerpt ? `\nExcerpt:\n${excerpt}` : ""}`;
		const compacted = { ...message, content: [{ type: "text" as const, text }], details: { ...details, harnessCompacted: true } };
		if (JSON.stringify(compacted).length >= JSON.stringify(message).length) return;
		replaceMessage(index, compacted);
		compactedResultSummaries.set(index, summary);
		omittedResults++;
	};
	// Stale reads go first so older reads that are still current survive longer.
	let supersededResults = 0;
	for (const index of supersededReadIndexes(projected.messages)) {
		if (projectedTokens <= inputLimit || (!pressure && index >= recentStart)) break;
		const before = omittedResults;
		compactResult(index);
		supersededResults += omittedResults - before;
	}
	// Keep user constraints and complete tool exchanges. Freeze compacted results so
	// later requests and persisted checkpoints never expand an earlier prefix again.
	for (let index = 0; projectedTokens > inputLimit && index < projected.messages.length; index++) {
		const message = projected.messages[index]!;
		if (!pressure && index >= recentStart) break;
		if (message.role === "assistant") {
			const content = message.content.map(block => {
				if (block.type !== "toolCall" || !completedCalls.has(block.id) || !["write_workspace", "edit_workspace"].includes(block.name)
					|| typeof block.arguments.path !== "string") return block;
				const args = { ...block.arguments };
				let changed = false;
				for (const key of block.name === "write_workspace" ? ["content"] : ["oldText", "newText"]) {
					const value = args[key];
					if (typeof value !== "string" || value.length <= 2048) continue;
					const sha = createHash("sha256").update(value).digest("hex");
					args[key] = `[Historical ${key} omitted: ${Buffer.byteLength(value)} bytes, sha256 ${sha}. This is a receipt, not file content. Inspect ${JSON.stringify(args.path)} for its current contents.]`;
					changed = true;
				}
				if (changed) compactedArguments++;
				return changed ? { ...block, arguments: args } : block;
			});
			if (content.some((block, index) => block !== message.content[index])) replaceMessage(index, { ...message, content });
			continue;
		}
		compactResult(index);
	}
	for (const [index, summary] of compactedResultSummaries) {
		if (projectedTokens <= inputLimit) break;
		const message = projected.messages[index]!;
		if (message.role !== "toolResult" || message.content.length !== 1 || message.content[0]?.type !== "text") continue;
		replaceMessage(index, {
			...message,
			content: [{ type: "text", text: summary }],
			details: message.details,
		});
	}
	for (const [index, message] of projected.messages.entries()) if (keys[index] && message !== context.messages[index]) retained.set(keys[index]!, message);
	const inputTokens = projectedTokens;
	if (inputTokens + maximumOutput > model.contextWindow) throw new RequestAdmissionError("context", `Request exceeds model context budget (${inputTokens} estimated input + ${maximumOutput} output > ${model.contextWindow}); preserve constraints and narrow the task or supplied context`);
	return { context: projected, inputTokens, maxOutputTokens: Math.min(requestedOutput, model.maxTokens, model.contextWindow - inputTokens), omittedResults, supersededResults, compactedArguments, retentionTokens, retentionExceeded: inputTokens > retentionTokens, estimator: countTokens === estimateRequestTokens ? "content-estimate-ascii-3-unicode-bytes-images-8192" : "application-token-counter" };
}

export function reserveRequest(state: RunSpendBudgetState, inputTokens: number, outputTokens: number, cost: Model<Api>["cost"]): Reservation {
	const reservation = requestReservation(inputTokens, outputTokens, cost);
	return reserveRequests(state, [reservation])[0]!;
}

/** Synchronous admission keeps a related set of requests atomic for callers sharing one state. */
export function reserveRequests(state: RunSpendBudgetState, reservations: Reservation[]): Reservation[] {
	assertRequestAdmission(state, reservations);
	state.reservedTokens = (state.reservedTokens ?? 0) + reservations.reduce((sum, reservation) => sum + reservation.tokens, 0);
	state.reservedCostUsd = (state.reservedCostUsd ?? 0) + reservations.reduce((sum, reservation) => sum + reservation.costUsd, 0);
	return reservations;
}

export function releaseReservation(state: RunSpendBudgetState, reservation: Reservation): void {
	state.reservedTokens = Math.max(0, (state.reservedTokens ?? 0) - reservation.tokens);
	state.reservedCostUsd = Math.max(0, (state.reservedCostUsd ?? 0) - reservation.costUsd);
}

export function assertRequestAdmission(state: RunSpendBudgetState, reservations: Reservation[]): void {
	const tokens = reservations.reduce((sum, reservation) => sum + reservation.tokens, 0);
	const costUsd = reservations.reduce((sum, reservation) => sum + reservation.costUsd, 0);
	if (state.maxTotalTokens !== undefined && state.totalTokens + (state.reservedTokens ?? 0) + tokens > state.maxTotalTokens) throw new RequestAdmissionError("tokens", "Aggregate token ceiling cannot admit the next request", {limit: state.maxTotalTokens, used: state.totalTokens, held: state.reservedTokens ?? 0, requested: tokens});
	if (state.maxCostUsd !== undefined && state.costUsd + (state.reservedCostUsd ?? 0) + costUsd > state.maxCostUsd) throw new RequestAdmissionError("cost", "Aggregate cost ceiling cannot admit the next request", {limit: state.maxCostUsd, used: state.costUsd, held: state.reservedCostUsd ?? 0, requested: costUsd});
}

export function requestReservation(inputTokens: number, outputTokens: number, cost: Model<Api>["cost"]): Reservation {
	return { inputTokens, outputTokens, tokens: inputTokens + outputTokens, costUsd: (inputTokens * Math.max(cost.input, cost.cacheRead, cost.cacheWrite) + outputTokens * cost.output) / 1_000_000 };
}

/** Some SDKs add reasoning tokens to the requested cap. Admit the actual JSON
 * payload before transmission, including that expansion and provider framing. */
export function reserveWireRequest(state: RunSpendBudgetState, reservation: Reservation, _preparedInput: number, _preparedOutput: number, payload: string, model: Pick<Model<Api>, "cost" | "maxTokens">): Reservation {
	const body = JSON.parse(payload);
	const output = body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens ?? body.generationConfig?.maxOutputTokens ?? model.maxTokens;
	if (!Number.isSafeInteger(output) || output < 1 || output > model.maxTokens) throw new Error("Invalid provider output ceiling");
	const additional = reserveRequest(state, Math.max(0, Buffer.byteLength(payload) + 1024 - reservation.inputTokens), Math.max(0, output - reservation.outputTokens), model.cost);
	return {
		inputTokens: reservation.inputTokens + additional.inputTokens,
		outputTokens: reservation.outputTokens + additional.outputTokens,
		tokens: reservation.tokens + additional.tokens,
		costUsd: reservation.costUsd + additional.costUsd,
	};
}

export function settleRequest(state: RunSpendBudgetState, reservation: Reservation | undefined, usage: { totalTokens: number; cost: { total: number } }, complete = true): void {
	state.totalTokens += usage.totalTokens;
	state.costUsd += usage.cost.total;
	// Interrupted streams can report partial usage. Keep their full reservation too.
	if (reservation && complete && usage.totalTokens > 0) {
		state.reservedTokens = Math.max(0, (state.reservedTokens ?? 0) - reservation.tokens);
		state.reservedCostUsd = Math.max(0, (state.reservedCostUsd ?? 0) - reservation.costUsd);
	}
}

export function createRequestAccounting(
	state: RunSpendBudgetState,
	preparedInput: number,
	preparedOutput: number,
	model: Pick<Model<Api>, "cost" | "maxTokens">,
	heldReservation?: Reservation,
) {
	let reservation: Reservation | undefined;
	let held = heldReservation;
	let settled = false;
 let failure: RequestAdmissionError | undefined;
 const capture = <T>(fn: () => T): T => { try { return fn(); } catch(error) { if(error instanceof RequestAdmissionError) failure = error; throw error; } };
 return {
  get failure() { return failure; },
  recordFailure(error: unknown) { if(error instanceof RequestAdmissionError) failure = error; },
		get reservation() { return reservation; },
		startAttempt() {
			if (settled) throw new Error("Request accounting is already settled");
			if (held) {
				reservation = held;
				held = undefined;
				return reservation;
			}
			return capture(() => reservation = reserveRequest(state, preparedInput, preparedOutput, model.cost));
		},
		admitWire(payload: string) {
			if (settled || !reservation) throw new Error("Wire admission requires an active request reservation");
			return capture(() => reservation = reserveWireRequest(state, reservation!, preparedInput, preparedOutput, payload, model));
		},
		settle(usage: { totalTokens: number; cost: { total: number } }, complete = true) {
			if (settled) throw new Error("Request accounting is already settled");
			settled = true;
			if (held) releaseReservation(state, held);
			held = undefined;
			if (failure && reservation) { releaseReservation(state, reservation); reservation = undefined; }
   settleRequest(state, reservation, usage, complete);
		},
	};
}
