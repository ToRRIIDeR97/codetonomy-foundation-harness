# Codetonomy foundation harness

The core of the [Codetonomy](https://github.com/ToRRIIDeR97/codetonomy) coding-agent
harness, packaged so any application can embed it. It compiles a task into bounded
capabilities, runs model turns through harness-owned tools and permissions,
verifies the outcome and writes a redacted trace. It has no terminal UI, CLI,
dashboard, memory store or OCR service; those stay in Codetonomy and plug into
this core the same way your application does.

Extracted from Codetonomy at commit `57bd19c` (30 September 2026).

## What is here

| Package | Role |
|---|---|
| `@agent-harness/runtime` | `createHarness().run()`: the agent loop, budgets, checkpoints, repair, cancellation, tool dispatch, model profiles and traces |
| `@agent-harness/task-compiler` | Turns an objective into task obligations and acceptance criteria |
| `@agent-harness/capability-compiler` | Chooses the preset, tools and stable system prompt |
| `@agent-harness/context-compiler` | Builds the bounded workspace context packet |
| `@agent-harness/tools` | Workspace tools, the native command sandbox, command output storage, and the `HarnessModule` interface |
| `@agent-harness/permissions` | Permission modes and the authorization gate |
| `@agent-harness/verifiers` | Outcome checks |
| `@agent-harness/telemetry` | Redacted, bounded trace events |
| `@agent-harness/contracts` | Shared types |
| `@agent-harness/orchestration`, `@agent-harness/module-orchestration` | Optional module: `delegate_tasks` and bounded sub-agent DAGs |

Model calls go through the pinned `@earendil-works/pi-ai` and `pi-agent-core`
0.84.1, with the patch in `patches/`.

Left in Codetonomy: the CLI, TUI and dashboard (`apps/`), provider configuration
and credential files (`config`), session files (`sessions`), skill discovery
(`skills`), the evaluation store and benchmarks (`evals`), the memoryDB documents
module with its PDF and OCR pipeline (`module-memorydb`, `document-ir`,
`memory-client`, `services/perception-ocr`), and the paid trial records.

## Setup

Node 22.19 or later, and pnpm through Corepack:

```bash
corepack pnpm install --frozen-lockfile
npm run check
npm test
```

`run_workspace_command` executes commands inside the Codex CLI's native sandbox.
Install the pinned version once, or point `CODETONOMY_CODEX_BIN` at a Codex binary
you already have:

```bash
node scripts/install-codex.mjs
```

Search tools use `rg` when it is on `PATH`.

## Use it from an application

```ts
import { createHarness } from "@agent-harness/runtime";

const result = await createHarness().run({
	objective: "Add a --json flag to the export command and test it",
	workspaceRoot: "/path/to/project",
	provider: "anthropic",
	modelId: "claude-opus-5",
	providerConfiguration: { id: "anthropic", name: "Anthropic", kind: "anthropic", apiKey: process.env.ANTHROPIC_API_KEY },
	permissionMode: "ask",
	approve: async (request) => askTheUser(request),
	maxCostUsd: 2,
	maxModelTurns: 40,
	onStream: (update) => render(update),
});

result.verification.passed; // did the requested outcome check out
result.output;              // the model's final answer
result.tracePath;           // redacted JSONL trace of the run
```

Your application supplies what Codetonomy's CLI supplied: the provider settings
and key (`providerConfiguration`), an approval handler for `ask` mode, stream and
trace observers, and, for multi-turn sessions, the `conversation` and
`transcript` from the previous run. Provider kinds: `openai`, `anthropic`,
`google`, `deepseek`, `openrouter`, `opencode`, `opencode-go`,
`openai-compatible` and `anthropic-compatible`. `provider: "fixture"` runs a
scripted offline model for tests.

[`examples/run-task.ts`](examples/run-task.ts) runs end to end offline:

```bash
node --import tsx examples/run-task.ts
```

## Modules

Extensions implement `HarnessModule` from `@agent-harness/tools` and are passed in
`options.modules`. A module can add read-only or approval-gated tools (with their
own prompt guidance), recall context before a run (budgeted by the core and placed
only in the user message), and capture results after it. The core never imports a
module. `createOrchestrationModule()` is the one shipped here; Codetonomy's
memoryDB documents module is built the same way.

## Tests

`tests/` holds the Codetonomy tests that exercise only these packages; cases that
needed the CLI, evaluation store, sessions, memoryDB or OCR were left in
Codetonomy. Tests that need a native tool skip themselves when it is missing:
`rg` for the search and Bash tests, and the Codex sandbox for
`tests/sandbox-conformance.test.ts`.

## Licensing

This project's own code is unlicensed (all rights reserved) until a license is
chosen. Third-party code and its notices are listed in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and
[`THIRD_PARTY_REUSE.yaml`](THIRD_PARTY_REUSE.yaml).
