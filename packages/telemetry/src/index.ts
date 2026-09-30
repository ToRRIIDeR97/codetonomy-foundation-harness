import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { redactAuditValue, type HarnessEvent, type HarnessEventType, type RunObserver } from "@agent-harness/contracts";

export class RunTrace {
	readonly runId: string;
	readonly path: string;
	readonly #observers: RunObserver[];
	readonly #knownSecrets: readonly string[];
	#sequence = 0;
	#write = Promise.resolve();

	constructor(runId: string, path: string, observers: RunObserver[] = [], knownSecrets: readonly string[] = []) {
		this.runId = runId;
		this.path = path;
		this.#observers = observers;
		this.#knownSecrets = knownSecrets;
	}

	async emit(type: HarnessEventType, data: Record<string, unknown> = {}, parentEventId?: string): Promise<HarnessEvent> {
		const redacted = redactAuditValue(data, "", this.#knownSecrets) as Record<string, unknown>;
		if (["tool.completed", "tool.failed", "tool.output.invalidated"].includes(type)) {
			if (typeof data.outputId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(data.outputId)) redacted.outputId = data.outputId;
			if (typeof data.outputOwner === "string" && /^[0-9a-f]{64}$/.test(data.outputOwner)) redacted.outputOwner = data.outputOwner;
		}
		const event: HarnessEvent = {
			eventId: randomUUID(),
			runId: this.runId,
			parentEventId,
			sequence: ++this.#sequence,
			timestamp: new Date().toISOString(),
			type,
			data: redacted,
		};
		if (type === "tool.failed") event.data.failureId = event.eventId;
		this.#write = this.#write.then(async () => {
			await mkdir(dirname(this.path), { recursive: true });
			const handle = await open(this.path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
			try {
				const info = await handle.stat();
				if (!info.isFile() || info.nlink !== 1) throw new Error("Trace path is not a regular standalone file");
				await chmod(this.path, 0o600);
				await handle.write(`${JSON.stringify(event)}\n`, undefined, "utf8");
			} finally {
				await handle.close();
			}
		});
		await this.#write;
		for (const observer of this.#observers) {
			try {
				await observer(event);
			} catch {
				// Observers are passive; trace persistence remains authoritative.
			}
		}
		return event;
	}
}
