# Pipelines

A **pipeline** is a declarative AI development workflow. SharkCraft stores
pipelines as typed objects (`IPipelineDefinition`) and surfaces them through
the CLI and MCP. The pipeline runtime does NOT execute steps — it tells the
agent (or the human) **what** to do, **in which order**, **with which tools**.

## Why declarative?

Imperative orchestrators (CI runners, agent loops) make agents harder to
audit. A declarative pipeline lets the agent answer:

> "What's the next step for this task?"

…by retrieving a typed plan whose steps reference MCP tool names, CLI
commands, knowledge ids, and templates. The agent (or user) executes each
step, with humans in the loop where `humanReview: true`.

## Defining a pipeline

```ts
import { definePipeline } from '@shrkcrft/pipelines';

export const featureDev = definePipeline({
  id: 'feature-dev',
  title: 'Feature development',
  description: 'Context → plan → apply → verify.',
  tags: ['feature'],
  appliesWhen: ['create-feature'],
  inputs: [{ name: 'task', required: true }],
  steps: [
    {
      id: 'context',
      type: 'context',
      mcpTools: ['inspect_workspace', 'get_relevant_context'],
      cliCommands: ['shrk context --task "<task>" --max-tokens 4000'],
      required: true,
    },
    {
      id: 'plan',
      type: 'generation-plan',
      mcpTools: ['create_generation_plan'],
      cliCommands: ['shrk gen <templateId> <name> --dry-run --save-plan <plan.json>'],
      humanReview: true,
    },
    {
      id: 'apply',
      type: 'apply-plan',
      cliCommands: ['shrk apply <plan.json>'],
      humanReview: true,
    },
    {
      id: 'verify',
      type: 'command',
      cliCommands: ['bun x tsc -p tsconfig.json --noEmit', 'bun test'],
      required: true,
    },
  ],
});
```

Pipelines live under `sharkcraft/pipelines.ts` by default (configurable via
`pipelineFiles` in `sharkcraft.config.ts`).

## Step types

| Type | What |
|---|---|
| `context` | Build / load context — no side effects. |
| `agent` | Pure agent thinking, instruction-only. |
| `generation-plan` | Produce a dry-run plan (via MCP `create_generation_plan` or CLI `shrk gen --dry-run`). |
| `apply-plan` | Apply a previously-saved plan via the CLI. |
| `command` | Run a shell command. |
| `mcp-tool` | Call an MCP tool. |

Other fields:

- `required` (default true) — must succeed.
- `humanReview` — pause for human approval before continuing.
- `enabledWhen` — name of an input that must be truthy.
- `references` — knowledge entry / template / path-convention ids worth
  showing alongside the step.

## CLI

```bash
shrk pipelines list                                       # all pipelines
shrk pipelines get feature-dev                            # one pipeline
shrk pipelines context feature-dev --task "<task>"        # pipeline + context
shrk pipelines plan feature-dev --task "<task>"           # plan, no execution
```

## MCP tools

| Tool | What |
|---|---|
| `list_pipelines` | All registered pipelines + step counts. |
| `get_pipeline { id }` | One pipeline (full). |
| `get_pipeline_context { id, task, maxTokens?, scope? }` | Pipeline + token-budgeted context for the task. |

## Default pipelines (this release)

- **dogfood-target**: `context-only`, `feature-dev`, `safe-generation`, `unit-test`.
- Pack-contributed pipelines (e.g. for a layered monorepo) are surfaced
  alongside the built-ins.

## What pipelines are NOT (in v0.1)

- Not a CI/CD runner. SharkCraft does not execute steps.
- Not a workflow engine with retries, fan-out, fan-in.
- Not a place to store secrets, tokens, or environment.

Pipelines are meta-data the agent reads to follow a discipline. The actual
execution stays in the agent (for MCP-tool steps) and the user (for CLI
commands).
