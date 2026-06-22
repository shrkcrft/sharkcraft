---
name: sharkcraft-dev
description: Bootstrap any SharkCraft development task. Loads CLI context, classifies the request, runs the right shrk subcommands, generates safely via the dry-run/apply flow, and validates before reporting done. Invoke for any change to packages/* or sharkcraft/* assets.
---

# SharkCraft development bootstrap

The developer asked for a change to the SharkCraft repo. The request is
often underspecified — your job is to ground yourself via the `shrk` CLI
*before* touching code, then walk the deterministic plan → review → apply
loop. Never hand-write what the CLI can scaffold.

## Prompt-as-file contract (read before anything else)

Tasks for this repo MUST be placed in a Markdown file, not pasted into the
chat. The convention is one file per round / one file per task, kept in
the repo (e.g. `prompts/<round>.md` or alongside the work).

**The first line of every task file MUST reference this skill**, e.g.

```markdown
Follow `.claude/skills/sharkcraft-dev/SKILL.md` from the first line.

# Round: <title>
... (task body) ...
```

If a prompt arrives in the chat without a file, your first action is to
*create the file* (under `prompts/` if it doesn't exist), put the task
body in it, prepend the SKILL.md reference, and then proceed. This keeps
prompts versioned, diffable, and replayable.

Once the file exists, follow the protocol below.

## Sister skill: `shrk-smart-context`

When the user gives you a *list* of upcoming tasks, or asks for a denser,
AI-synthesised brief than `shrk context` produces, switch to the
`shrk-smart-context` skill. It covers `shrk smart-context`, `plan-ahead`,
and the saved-plans workflow. This skill (`sharkcraft-dev`) is for
executing a single scoped change end-to-end.

## Protocol

### 1. Load context (ALWAYS FIRST)

```bash
shrk doctor
shrk context --task "<one-sentence summary of the request>"
```

Non-negotiable. `doctor` confirms the workspace is healthy. `context`
grounds you in the relevant rules, paths, and templates for the task at
hand. If `doctor` reports errors, fix those before doing anything else.

### 2. Classify the request

From the user's sentence, decide the construct:

| Signal | Construct | Where it lives |
|---|---|---|
| "new CLI command" / "new shrk subcommand" | top-level or grouped command | `packages/cli/src/commands/*` + register in `main.ts` |
| "new MCP tool" / "expose X to agents" | MCP tool | `packages/mcp-server/src/tools/*` + add to `ALL_TOOLS` |
| "new boundary rule" / "block import of X" | boundary rule | local `sharkcraft/boundaries.ts` or a pack |
| "new pipeline" / "new task flow" | pipeline | `sharkcraft/pipelines.ts` |
| "new preset" / "preset for X-style repos" | preset | `packages/presets/src/builtin/*` |
| "new template" / "scaffold a new construct" | template | `sharkcraft/templates.ts` |
| "new pack" / "ship knowledge for project X" | pack | new package in `packages/<pack>/` |
| "improve onboarding" / "better inference for X" | inference engine | `packages/inspector/src/onboarding.ts` |
| "validate Y" / "new doctor check" | doctor / coverage / drift | `packages/inspector/src/*` |
| "docs only" | docs | `docs/*` |

When unsure, run a focused task packet and let the ranker tell you:

```bash
shrk task "<task>" --json
```

### 3. Discover details (your job — prompts are usually thin)

Run the subset that matches:

```bash
# What already exists?
shrk knowledge search "<keywords>"
shrk rules list
shrk paths list
shrk templates list
shrk pipelines list
shrk presets list
shrk packs list

# Understand existing code before you touch it (use the graph, not grep —
# it returns path:line truth). Run `shrk graph index` first if it's stale.
shrk graph callers <symbol>            # who calls / references X (path:line)
shrk graph context <file-or-symbol>    # imports, callers, bridge + framework — is X wired?
shrk graph impact <file-or-symbol> --full   # what breaks if I change this
shrk graph why <fromId> <toId>         # shortest-path between two graph nodes

# Will my plan introduce boundary trouble?
shrk check boundaries --json
shrk plan review <plan.json>

# What's currently weak (drives priority)?
shrk coverage --json
shrk drift --json
```

Also read the relevant doc in `docs/` — that file is the canonical
reference. If the doc is missing, plan to add it alongside the code change.

### 4. Confirm only when it matters

Ask the developer at most one short question, only if the answer would
change the *layer* or *file path*. Examples of good questions:

- "Should this rule ship in an adopter pack or as a generic preset?"
- "New CLI subcommand under an existing group (e.g. `shrk packs ...`),
  or a top-level `shrk <verb>` command?"

Don't ask cosmetic questions. Don't ask multiple questions serially.

### 5. Scaffold via the CLI (do NOT hand-write boilerplate)

```bash
shrk gen <template-id> <name> [--var key=value ...] --dry-run --save-plan /tmp/plan.json
shrk plan review /tmp/plan.json
shrk apply /tmp/plan.json --verify-signature
```

If a template doesn't exist for the construct, generate one as part of the
task (and add it to `sharkcraft/templates.ts` so the next person doesn't
hand-write either). For MCP tools and CLI commands, mirror the closest
existing sibling — naming and registration must match.

### 6. Implement

- Single export per file. `I`-prefixed interfaces. Enums over unions.
- No logic in constructors.
- Absolute imports from `@shrkcrft/<package>` only; no relative paths
  across package boundaries.
- Errors flow through `Result` + `AppErrorImpl` from `@shrkcrft/core`
  on public APIs.
- **Never make MCP write anything.** New MCP tools return data + a
  next-command hint; the human runs the CLI to apply.

### 7. Validate

```bash
bun x tsc -p tsconfig.base.json --noEmit       # types
bun test <focused-file>                        # the specific tests
bun test                                       # full suite (cheap on Bun)
shrk doctor                            # config + entries
shrk check boundaries                  # cross-layer imports
shrk coverage                          # what's still missing
shrk packs doctor --require-signatures # if packs touched
```

Before claiming done on a significant change:

```bash
bun run build:dist
bun run release:preflight                       # the real gate
```

Anything red here blocks "done."

### 8. Report

One compact summary:
- Construct + name.
- Files touched (use `path:line` notation).
- New tests added + green count.
- Validation result (`tsc / bun test / shrk doctor / shrk check boundaries`).
- Any assumption you made the user didn't specify (so they can correct).

If the change touches release behavior or pack contributions, mention
`release:preflight` explicitly.

## When to start a session

```bash
shrk session start "<task description>"
```

Starts a session under `.sharkcraft/sessions/<timestamp>-<slug>/`. Use it
for any multi-turn or multi-PR change so the next turn can `shrk session
diff` and recover.

## Tests

**Default: write tests for new public surfaces.** SharkCraft is a tool used
by other tools — the contract is the artifact.

Skip tests only when:
- The change is pure docs.
- The change is a non-runtime template body.
- An existing test already covers the surface end-to-end.

When in doubt, write the test.

## Don'ts

- Don't accept a chat-only prompt. Materialize it as a file with the
  SKILL.md reference on line 1 first.
- Don't skip `shrk doctor` / `shrk context` at the start.
- Don't hand-write a CLI command or MCP tool body when a sibling exists —
  copy the sibling, change the names, register it.
- Don't bypass `apply --verify-signature` to land code.
- Don't add a write capability to MCP. Ever.
- Don't add a verification command to a pack and assume `apply` will run
  it automatically — it won't. Local `sharkcraft.config.ts` is the only
  trusted source.
- Don't ship without `bun run release:preflight` for anything touching
  publish / signing / boundaries.

## Quick-reference: where to add what

| Want to add … | Edit |
|---|---|
| A new top-level CLI command | `packages/cli/src/commands/<x>.command.ts` + `main.ts` |
| A subcommand under an existing group | same dir, register via `registerSubcommand('<group>', ...)` |
| A new MCP tool | `packages/mcp-server/src/tools/<x>.tool.ts` + `tools/index.ts` `ALL_TOOLS` |
| A new preset | `packages/presets/src/builtin/builtin-presets.ts` |
| A new boundary rule | local `sharkcraft/boundaries.ts` or a pack's `boundaries.ts` |
| Pack manifest changes | the pack's `package.json` + its `dist/manifest.json` (re-sign) |
| Inference rule | `packages/inspector/src/onboarding.ts` + a test in its `__tests__/` |
| Docs only | `docs/<topic>.md` (one file per concept; cross-link from `overview.md`) |
