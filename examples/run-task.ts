// Embed the harness in an application: run one task against a workspace and read the result.
//
//   node --import tsx examples/run-task.ts <workspace>                     # offline, scripted "fixture" model
//   ANTHROPIC_API_KEY=... node --import tsx examples/run-task.ts <workspace>  # a real model
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, type HarnessRunOptions } from "../packages/runtime/src/index.ts";
import { createOrchestrationModule } from "../packages/module-orchestration/src/index.ts";

const workspaceRoot = process.argv[2] ?? await mkdtemp(join(tmpdir(), "foundation-example-"));
if (!process.argv[2]) await writeFile(join(workspaceRoot, "README.md"), "# Example project\n");

const apiKey = process.env.ANTHROPIC_API_KEY;
const provider: Partial<HarnessRunOptions> = apiKey
	? { provider: "anthropic", modelId: "claude-opus-5", providerConfiguration: { id: "anthropic", name: "Anthropic", kind: "anthropic", apiKey } }
	: { provider: "fixture", modelId: "faux-1" };

const result = await createHarness().run({
	objective: "Summarize README.md",
	workspaceRoot,
	traceDirectory: join(workspaceRoot, ".harness", "runs"),
	// "ask" (default) calls `approve` before writes and commands; "auto" allows them inside the workspace.
	permissionMode: "auto",
	maxModelTurns: 12,
	maxCostUsd: 0.5,
	// Optional modules plug in here; the core never imports them.
	modules: [createOrchestrationModule()],
	onStream: (update) => { if (update.kind === "text") process.stdout.write("."); },
	...provider,
});

console.log(`\n${result.verification.passed ? "verified" : "not verified"}: ${result.output}`);
console.log(`trace: ${result.tracePath}`);
