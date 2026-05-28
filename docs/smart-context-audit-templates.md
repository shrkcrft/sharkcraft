# `shrk smart-context audit-*`

Local-LLM-enriched audits for user-defined SharkCraft constructs.
**Report-only.** Never edits source files. Three constructs are covered:

| Command | What it audits |
|---|---|
| `shrk smart-context audit-templates`  | User templates (`sharkcraft/templates.ts`) |
| `shrk smart-context audit-knowledge`  | User knowledge entries (`sharkcraft/knowledge.ts`, `rules.ts`, etc.) |
| `shrk smart-context audit-pipelines`  | User pipelines (`sharkcraft/pipelines.ts`) |

All three share the same shape:
- **Deterministic core** — wraps the existing `@shrkcrft/inspector` primitives
  for the construct (e.g. `lintTemplates` + `buildTemplateDriftReport`,
  `lintKnowledge` + `buildKnowledgeStaleReport`, `lintPipelines`).
- **LLM critique pass** (opt-in via no flag; suppressed with `--no-enhance`).
- **Fix plan** (opt-in via `--fix-plan` / `--only-plan`) — a Claude-targetable
  instruction set the agent executes via its own Edit tool.
- **`ai` block** carried on every report — always present, with setup
  steps when no provider is reachable.

This document focuses on `audit-templates`. The other two follow the
same flag surface; substitute `templates` → `knowledge` / `pipelines`.

---

# `shrk smart-context audit-templates`

Local-LLM-enriched audit for user templates. **Report-only.** Never edits
template sources. Useful when a workspace has more templates than is
practical to hand-review.

```bash
shrk smart-context audit-templates                    # audit all user templates
shrk smart-context audit-templates --id <templateId>  # audit one template
shrk smart-context audit-templates --no-enhance       # deterministic only, skip LLM
shrk smart-context audit-templates --save             # persist report (timestamped, one entry per run)
shrk smart-context audit-templates --json             # machine-readable, for Claude
shrk smart-context audit-templates --fix-plan         # also emit a Claude-targetable fix plan
shrk smart-context audit-templates --only-plan        # emit just the fix plan, suppress the audit body
```

## What it does

The audit is a three-pass pipeline. Passes 1 and 3 always run; pass 2
is opt-in and only fires when a local LLM (Ollama / llama.cpp) is
reachable via `selectAiProvider`'s `auto → llamacpp → ollama` walk.

| Pass | What runs | Source |
|---|---|---|
| 1. Deterministic | `lintTemplates` + `buildTemplateDriftReport` from `@shrkcrft/inspector`, merged and deduped by `(category + message)` | Always |
| 2. LLM critique  | Per template: send body + variables + sample target path + deterministic findings + sibling summaries; ask for stale phrasing, content bugs, style drift, missing variables peers now declare | Only when LLM reachable |
| 3. Summarise     | Per template: verdict + grouped findings + suggested actions; workspace-level rollup | Always |

## Hard guarantees

- **No writes** anywhere. Report only.
- **No auto-fix in v1.** Suggested actions are advisory text.
- **Offline-safe.** Pass 1 + Pass 3 always run; Pass 2 is enrichment.
- **User templates only in v1.** Pack-contributed templates are signed
  and skipped (listed under `report.skipped[]`).
- **No new inspection primitives** in `packages/templates/*` — the
  existing `templates lint` / `templates drift` are the source of truth.

## Verdict scale

| Verdict | Trigger |
|---|---|
| `broken` | any `error`-severity deterministic finding |
| `stale`  | any `warn`-severity finding, or `≥ 3` info findings |
| `minor`  | 1–2 info findings, no warns/errors |
| `ok`     | no findings |

LLM findings are advisory and do **not** influence the verdict.

## Report contract

JSON (one record per template):

```json
{
  "auditId": "audit-2026-05-28T12-34-56-789Z",
  "generatedAt": "2026-05-28T12:34:56.789Z",
  "llmEnriched": true,
  "llmProviderId": "ollama",
  "templates": [
    {
      "templateId": "engine.cli-command",
      "templateName": "CLI command (shrk subcommand)",
      "verdict": "minor",
      "usage": "unknown",
      "deterministicFindings": [
        {
          "severity": "info",
          "category": "related-id-unresolved",
          "message": "related id \"typescript.files.one-export\" not found.",
          "sources": ["templates drift"]
        }
      ],
      "llmFindings": [
        {
          "severity": "info",
          "category": "stale-phrasing",
          "message": "Description references the legacy generator API.",
          "confidence": 0.6
        }
      ],
      "suggestedActions": [
        {
          "kind": "investigate",
          "target": "engine.cli-command",
          "note": "Sample path does not match any registered path convention — confirm targetPath aligns with paths.ts."
        }
      ]
    }
  ],
  "skipped": [
    { "templateId": "vendor.something", "reason": "pack-contributed (out of scope for v1 audit)" }
  ],
  "summary": { "ok": 0, "minor": 2, "stale": 0, "broken": 0, "total": 2 }
}
```

Markdown summary groups templates by verdict; each finding is tagged
`[deterministic]` or `[llm]` plus the originating command list, so a
reader (or Claude) can tell at a glance what to trust without
verification.

## Saved reports

`--save` writes both the JSON and the Markdown view to
`.sharkcraft/smart-context/<auditId>.{md,json}` — one entry per run, so
diffs across runs are trivial. Reports surface in
`shrk smart-context list` next to other saved entries.

## Defaults (locked for v1)

- User templates only.
- No writes.
- Deterministic findings always run.
- LLM findings advisory.
- Verdict: `ok | minor | stale | broken`.
- Severity: `info | warn | error`.
- `--save` writes one timestamped entry per run.
- `usage` is always `"unknown"` (no usage signal in v1).
- No auto-fix.
- Dedup strategy: by `(category + message)`, retaining a `sources[]`
  trail per finding so origin is never lost.

## Fix plan (`--fix-plan` / `--only-plan`)

The audit alone is report-only. When passed `--fix-plan`, the command
also emits a structured **fix plan** derived from the audit findings.
The plan is a machine-readable instruction set Claude executes against
`sharkcraft/templates.ts` via its own Edit tool — SharkCraft itself
still does not write to template sources.

### Plan shape

```json
{
  "fixPlanId": "fix-2026-05-28T...",
  "generatedAt": "...",
  "auditId": "audit-2026-05-28T...",
  "sourceFiles": ["sharkcraft/templates.ts"],
  "fixes": [
    {
      "templateId": "engine.cli-command",
      "findingCategory": "related-id-unresolved",
      "finding": "related id \"typescript.files.one-export\" not found...",
      "severity": "info",
      "intent": "Remove the unresolved related id from this template's related[].",
      "agentPrompt": "Open sharkcraft/templates.ts. Find the template with id ...",
      "confidence": "high",
      "source": "deterministic"
    }
  ],
  "skipped": [
    { "templateId": "x", "findingCategory": "unsafe-target", "finding": "...", "reason": "security-sensitive — requires human review" }
  ],
  "summary": { "fixCount": 3, "highConfidence": 1, "mediumConfidence": 2, "lowConfidence": 0, "skipped": 1 }
}
```

### Per-category dispatch

| Category | Behavior | Confidence |
|---|---|---|
| `unsafe-target` | **skipped** | — (security-sensitive) |
| `missing-name` | fix instruction | high |
| `missing-description` | fix instruction | high |
| `related-id-unresolved` | fix instruction (names the bad id) | high |
| `undocumented-var` | fix instruction (names the variable) | medium |
| `required-var-no-example` | fix instruction (names the variable) | medium |
| `undeclared-var` | fix instruction (names the placeholder) | medium |
| `path-no-convention` | fix instruction (offers two paths) | low |
| any other deterministic category | generic fix instruction | low |
| any LLM finding | advisory fix instruction tagged `source: "llm"` | low |

### Saved layout

With `--fix-plan --save`, both files are written under
`.sharkcraft/smart-context/`:

```
audit-<timestamp>.{md,json}   ← the audit report
fix-<timestamp>.{md,json}     ← the fix plan derived from it
```

The plan references its source via `auditId`, so plans and reports can
be paired after the fact.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Audit ran; no `broken` templates |
| `1` | At least one `broken` template, or `--id` not found |
| `2` | Bad usage |

## AI configuration hints (`ai` block)

Every audit run carries a structured `ai` block so Claude (or a human)
can self-configure shrk for the best result without external prompts:

```json
{
  "ai": {
    "reachable": false,
    "requestedProvider": "auto",
    "providerId": null,
    "enhancementSkipped": false,
    "hints": [
      {
        "level": "setup",
        "title": "Enable LLM enrichment for deeper analysis",
        "steps": [
          "Local-first: install Ollama (https://ollama.com/download) or set LLAMACPP_MODEL_PATH for in-process inference.",
          "Pull a model that fits your machine — e.g. `ollama pull llama3.2` or `ollama pull qwen2.5-coder:7b`.",
          "Optional: export OLLAMA_HOST=http://localhost:11434 (default).",
          "Optional: export OLLAMA_MODEL=<id> to pin the model.",
          "Re-run without --no-enhance."
        ]
      }
    ]
  }
}
```

Hint levels:
- `setup`   — no provider reachable; steps tell the user how to enable LLM.
- `info`    — informational (e.g. `--no-enhance` was explicitly passed).
- `upgrade` — provider reachable; tips for sharper output (model choice, etc.).

The block is also rendered into the Markdown view as a final
"## AI configuration" section.

## LLM-enriched fix plan (`llmSuggestion`)

When `--fix-plan` runs with a reachable LLM, each fix instruction in
the plan gets an additional `llmSuggestion` field — a concrete
suggestion that sharpens the deterministic agent prompt. Examples:

- `required-var-no-example` → suggested concrete value (replacing `<sample value>`).
- `undeclared-var` → "ADD" vs "REMOVE" recommendation with rationale.
- `path-no-convention` → suggested paths.ts entry to add.

Without an LLM, `llmSuggestion` is absent and the agent works from
the deterministic prompt alone. The agent prompt remains the source
of truth — `llmSuggestion` is advisory and tagged as such.

## Other commands that grew LLM enrichment (Part E)

| Command | Flag | What it adds |
|---|---|---|
| `shrk doctor` | `--llm-recommendations` | A `llmRecommendations` envelope appended to JSON output (with the `ai` block) and rendered to Markdown after the summary. |
| `shrk templates drift` | `--llm-recommendations` | Same envelope, asking the LLM to propose ONE concrete fix per FAIL/WARN entry. |
| `shrk templates lint` | `--llm-recommendations` | Same envelope, asking the LLM for ONE concrete edit per non-passing template — names the specific field in `sharkcraft/templates.ts`. |
| `shrk ai-status` (new top-level) | `--ping` | One-shot self-check of the LLM wiring. Always emits the `ai` block so Claude can self-configure without running an audit. `--ping` adds a live round-trip verification. |

Without the flag, both commands' output is byte-stable vs the
pre-LLM behavior. The flag is fully opt-in and a no-op when no
provider is reachable (the envelope still emits the `ai` block with
setup hints so Claude knows how to enable the LLM).

## Out of scope (current versions)

- Pack-contributed templates.
- Actually applying fixes from the CLI. The plan is emitted; the agent
  applies. (v2 added the plan; the CLI remains write-free on this path.)
- Usage signal — needs its own round; surface stays `unknown`.
- A `polish` LLM pass.
- A unified `audit` group across rules / paths / pipelines. If wanted
  later, `smart-context audit-templates` is the first of many
  `smart-context audit-*` siblings without breaking shape.
- A "watch" loop that re-audits after the agent applies fixes.

## Related

- `docs/smart-context.md` — the broader smart-context surface.
- `docs/templates.md` — the underlying template registry.
- `prompts/smart-context-audit-templates.md` — the round-of-work prompt
  that drove this feature, kept for reference.
