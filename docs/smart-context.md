# `shrk smart-context` — AI-backed context enrichment

## What it is

`shrk smart-context "<task>"` builds the same deterministic context the
SharkCraft engine produces (rules + paths + templates + project
overview + recommended commands), then asks an AI provider to
synthesise it into either:

- a **brief** (default) — a concise Markdown summary the agent can read
  before starting work, or
- a **plan** (`--plan`) — a structured JSON plan with `filesToRead`,
  `filesToEdit`, `relatedRules`, `relatedTemplates`, `firstCommands`,
  `implementationSteps`, `gotchas`, and `openQuestions`, or
- a **two-stage development plan** (`--ai-plan`) — an opt-in planning
  flow where stage 1 asks the model what more context SHRK should
  collect, SHRK gathers that context deterministically, and stage 2
  returns a richer handoff plan for Claude.

The calling agent (Claude, Codex, etc.) picks the form per call. Brief
is right when you just need orientation; plan is right when you want a
concrete next-step list to act on. `--ai-plan` is for cases where the
first deterministic packet is useful but still too shallow to hand to
an implementation model directly.

## Why it's an opt-in command, not a default

`docs/philosophy.md` is clear: the SharkCraft retrieval engine is
deterministic. Same input → same output. No language-model "vibes"
inside the engine itself.

`smart-context` does not change that. It sits next to `shrk ask` as an
**explicit, named, opt-in LLM surface**. SharkCraft is local-only: the
LLM is always either an Ollama daemon you control or an in-process
llama.cpp model. No hosted APIs, no keys to leak. The defaults — `shrk
context`, `shrk brief`, `shrk task`, and every MCP tool — stay
deterministic and network-free.

Pick `shrk context` / `shrk brief` when you need reproducibility, audit
trails, or offline operation. Pick `shrk smart-context` when you want
the model to interpret that deterministic seed and produce richer
prose.

## Usage

```bash
# Brief mode (default).
shrk smart-context "add a new shrk subcommand under packs"

# Plan mode — JSON plan + short Markdown summary.
shrk smart-context "add a new shrk subcommand under packs" --plan

# Two-stage development plan — richer Claude handoff.
shrk smart-context "add a new shrk subcommand under packs" --ai-plan --json

# Print the exact prompt(s) without calling the provider.
shrk smart-context "..." --dry-run
shrk smart-context "..." --plan --dry-run
shrk smart-context "..." --ai-plan --dry-run

# Machine-readable envelope (deterministic seed + AI response side-by-side).
shrk smart-context "..." --json
```

### Flags

| Flag | Default | Notes |
|---|---|---|
| `--plan` | off | Emit a structured plan instead of a brief. |
| `--ai-plan` | off | Run the opt-in two-stage planning flow and force `plan` mode. |
| `--provider <auto\|ollama\|llamacpp>` | `auto` | Local-only. `auto` walks `llamacpp → ollama`. |
| `--enhance` / `--no-enhance` | on (brief mode) | Toggle the multi-pass enhancement pipeline. Off → single-shot LLM call. |
| `--enhance-passes <n>` | `4` (all stages) | Cap pipeline depth (e.g. `2` runs only `draft + critique`). |
| `--model <id>` | provider default | Any model your selected provider can serve. |
| `--max-tokens <n>` | `3072` (brief) / `6144` (plan) | Cap on the per-call response. |
| `--stage1-max-tokens <n>` | `min(2048, maxTokens)` | Cap on Stage 1 when `--ai-plan` is enabled. |
| `--seed-tokens <n>` | `3500` | Token budget for the deterministic seed sent to the LLM. |
| `--expansion-tokens <n>` | `2200` | Budget for the deterministic extra context sent into Stage 2. |
| `--expansion-limit <n>` | `12` | Hard cap on how many extra files/rules/risk items SHRK collects. |
| `--dry-run` | off | Print the prompt; do not call the LLM. |
| `--debug` | off | Print the initial smart-context result, Stage 1 request, selected files, and final plan before the rendered output. |
| `--json` | off | Emit a JSON envelope (deterministic seed + AI response + per-stage enhancement telemetry). |

### Provider configuration

Local-only. Put the host/model in the repo's `.env`:

```bash
# Provider: ollama (default) or llamacpp.
AI_PROVIDER=ollama

# Ollama: either a full URL …
OLLAMA_HOST=http://my-box:11434
# … or a bare host + port (assembled as http://<host>:<port>):
# OLLAMA_HOST=my-box
# OLLAMA_PORT=11434
OLLAMA_MODEL=qwen2.5-coder

# llama.cpp (in-process, no daemon).
LLAMACPP_MODEL_PATH=/path/to/qwen2.5-coder-3b.gguf
```

`.env` is gitignored. The `shrk` binary auto-loads `.env` from the
current directory (walking up to the filesystem root) at startup, but
never overwrites a value already set in the shell — so an
`OLLAMA_HOST=… shrk smart-context …` one-off works too.

### Multi-pass enhancement pipeline

When an LLM is reachable and `--no-enhance` is not passed, brief mode
runs a four-stage refinement loop:

1. **draft**    — synthesise an initial brief from the deterministic seed.
2. **critique** — find gaps, vague claims, contradictions in the draft.
3. **refine**   — rewrite the brief to resolve every critique line.
4. **polish**   — final pass for Claude-agent ergonomics (file:line refs,
                  imperative bullets, scannable RISK/UNKNOWN markers).

Each stage's transcript is captured into the conversation file (under
`--save-conversation`). When the LLM is *not* reachable, the deterministic
seed is the final output — exactly as before. A failed stage degrades to
the last successful output; the pipeline never returns less than the
deterministic input.

Use `SHRK_ENHANCE=off` or `--no-enhance` to disable the pipeline globally
(single-shot LLM call). Use `SHRK_ENHANCE_PASSES=2` or `--enhance-passes 2`
to cap depth on slow models.

## What gets sent to the provider

The seed payload is bounded and contains only what the engine already
exposes deterministically:

- The task string.
- The project overview (workspace + framework summary).
- The top-ranked rules, paths, and templates for the task (from
  `buildTaskPacket`).
- The recommended CLI commands and pipelines.
- The knowledge-context body that `shrk context --task "<task>"` would
  return, capped at `--seed-tokens`.

With `--ai-plan`, Stage 1 also sees bounded graph/search grounding, and
Stage 2 sees additional deterministic context that SHRK collected from
the Stage 1 request. The expansion pass is capped by
`--expansion-limit` and `--expansion-tokens`.

It does **not** read or attach arbitrary source-file contents by
default. If you want the provider to see file bodies, run
`shrk smart-context --dry-run` first, append the file bodies you need,
and feed the result into your own provider call.

## Fallback behavior

`--ai-plan` is opt-in and backward compatible. If no AI provider is
configured, SHRK does **not** fail the whole command; it falls back to a
deterministic smart-context payload and reports that fallback in the
JSON envelope / debug output.

## What `smart-context` is not

- **Not** a write surface. It returns text; it never edits files.
- **Not** an MCP tool. The MCP server stays read-only and deterministic.
- **Not** a replacement for `shrk apply` review. Treat the AI-produced
  plan as an enriched brief, not as ground truth — verify rule IDs,
  paths, and commands against the deterministic seed before acting.
