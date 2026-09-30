import type { Message } from "@earendil-works/pi-ai";
import { validateConversationTranscript } from "@agent-harness/contracts";

/**
 * Messages for a resumable session checkpoint after `base` (the last prepared
 * request) and `current` (the agent's messages so far). Returns undefined when
 * no valid transcript can be formed.
 */
export function resumableCheckpointMessages(base: Message[] | undefined, current: Message[]): Message[] | undefined {
	const prefix = base ?? [];
	const completedTail = current.slice(prefix.length).filter(message => message.role !== "assistant" || !["error", "aborted"].includes(message.stopReason));
	const full = [...prefix, ...completedTail];
	// An interruption can stop between a tool call and its result. Keep
	// every completed exchange, drop only calls whose results never
	// arrived, and never invent a result for an unknown operation. The
	// pairing pass clones each kept message once and validates once,
	// replacing the former quadratic clone-and-validate prefix scan.
	const resultIds = new Set(full.flatMap((message) => message.role === "toolResult" ? [message.toolCallId] : []));
	const keptCallIds = new Set<string>();
	const consumedResults = new Set<string>();
	const paired: Message[] = [];
	for (const message of full) {
		if (message.role === "assistant") {
			const content = message.content.filter((block) => block.type !== "toolCall" || resultIds.has(block.id));
			if (!content.length && message.content.length) continue;
			paired.push(structuredClone(content.length === message.content.length ? message : { ...message, content }));
			for (const block of content) if (block.type === "toolCall") keptCallIds.add(block.id);
			continue;
		}
		if (message.role === "toolResult") {
			if (!keptCallIds.has(message.toolCallId) || consumedResults.has(message.toolCallId)) continue;
			consumedResults.add(message.toolCallId);
		}
		paired.push(structuredClone(message));
	}
	try { validateConversationTranscript({ version: 1, messages: paired }); return paired; } catch {}
	if (!base) return undefined;
	const candidate = structuredClone(base);
	try { validateConversationTranscript({ version: 1, messages: candidate }); return candidate; } catch {}
	return undefined;
}
