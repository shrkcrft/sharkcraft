Follow `.claude/skills/sharkcraft-dev/SKILL.md` from the first line.

# Round: `shrk smart-context audit-templates` — local-LLM template audit (v1, report-only)

## Goal

Add a new subcommand `shrk smart-context audit-templates` that audits the
user's templates and produces a single trustworthy report Claude (or the
developer) can act on. v1 is **report-only** — no auto-fix, no MCP
writes, no edits to template sources.

## Why

Developers with many templates currently rely on Claude reading each
template inline. Slow, non-deterministic, burns context, drifts between
reviews. A `shrk` command that batches the audit locally lets the
developer or Claude consume one report. The fix loop stays where
SharkCraft already lives (`shrk gen` / direct edits).

## Surface

```bash
shrk smart-context audit-templates                    # audit all user templates
shrk smart-context audit-templates --id <template>    # audit one template
shrk smart-context audit-templates --no-enhance       # deterministic only, skip LLM
shrk smart-context audit-templates --save             # persist report (timestamped, one entry per run)
shrk smart-context audit-templates --json             # machine-readable, for Claude
```

Lives under the existing `smart-context` command group to reuse the LLM
provider walk (`auto → llamacpp → ollama`), `--no-enhance` semantics, and
the saved-entries workflow (`shrk smart-context list` / `show`).

## Key discovery (changes the implementation shape)

The deterministic layer is already implemented as standalone commands
under the `templates` group:

| Existing command | What it produces |
|---|---|
| `shrk templates doctor`       | per-template pass/warn/fail + info findings, render checks |
| `shrk templates lint`         | variable-level lint (missing examples, patterns, unused vars) |
| `shrk templates drift`        | drift vs. paths/rules (`path-no-convention`, `related-id-unresolved`, etc.) |
| `shrk templates verify-paths` | `targetPath` validation against `paths.ts` |
| `shrk templates smoke`        | render every template with a sample name, surface errors |

All emit `--json`. The audit command does **not** re-implement any of
these — it orchestrates them, dedupes the overlap, adds an LLM critique
pass, and writes one report.

## Pipeline (revised)

```
Pass 1 — Aggregate deterministic findings (always runs)
  Invoke the existing template inspection primitives in-process (no spawn —
  import the inspection functions the commands wrap and call them
  directly). Merge results per template. Dedup by (category + location)
  with a `sources: ["doctor", "drift", ...]` tag preserved on each
  finding so the origin is never lost.

Pass 2 — LLM critique (opt-in, only if Ollama/llamacpp reachable)
  Per template: feed {body + variables + targetPath fn body + render
  preview + aggregated deterministic findings + small corpus slice
  (sibling templates, related rules)} to the provider.
  Ask: stale phrasing, off-style vs peers, missing variables peers now
  declare, subtle content bugs the deterministic layer can't see,
  suggested edits.

Pass 3 — Summarize
  Per template: verdict (ok | minor | stale | broken), grouped findings,
  suggested actions. Workspace-level rollup on top.
```

No `polish` pass — we want findings, not prose. When no LLM is reachable
the audit still runs end-to-end with Pass 1 + Pass 3; the report says so
explicitly and the LLM findings array is empty.

## Report contract

```json
{
  "audit_id": "audit-2026-05-28T...",
  "template_id": "engine.cli-command",
  "verdict": "ok | minor | stale | broken",
  "usage": "unknown",                         // v1: always "unknown" — no usage signal yet
  "deterministic_findings": [
    {
      "severity": "info | warn | error",
      "category": "related-id-unresolved",
      "message": "related id \"typescript.files.one-export\" not found.",
      "location": "related[0]",
      "sources": ["templates doctor", "templates drift"]   // dedup origin trail
    }
  ],
  "llm_findings": [
    {
      "severity": "info | warn | error",
      "category": "stale-phrasing | missing-variable | content-bug | style-drift",
      "message": "...",
      "confidence": 0.0
    }
  ],
  "suggested_actions": [
    { "kind": "edit | regenerate | retire | investigate", "target": "...", "note": "..." }
  ]
}
```

Markdown summary groups templates by verdict; each finding tagged
`[deterministic]` / `[llm]` with the source list so the reader knows what
to trust without verification.

## Hard guarantees

- **No writes** anywhere. Report only.
- **No auto-fix** in v1. `suggested_actions` are advisory text only.
- **Offline-safe.** Pass 1 + Pass 3 always run; Pass 2 is enrichment.
- **User templates only** in v1. Pack-contributed templates are signed
  and explicitly out of scope.
- **No new inspection primitives** in `packages/templates/*`. The
  existing commands are the source of truth.

## Defaults (locked)

- User templates only.
- No writes.
- Deterministic findings always run.
- LLM findings advisory.
- Verdict: `ok | minor | stale | broken`.
- Severity: `info | warn | error`.
- `--save` writes one timestamped entry per run (diffs over time are trivial).
- `usage` always `"unknown"` for v1.
- No auto-fix.
- Dedup strategy: by `(category + location)`, keep `sources[]` tag.

## File plan

| File | Action | Why |
|---|---|---|
| `packages/cli/src/commands/smart-context.command.ts` | extend | add `smartContextAuditTemplatesCommand` (mirror existing siblings) |
| `packages/cli/src/main.ts`                            | edit   | `registry.registerSubcommand('smart-context', ...)` |
| `packages/cli/src/audit/templates-audit.ts` (new)     | new    | orchestrator: in-process invocation + dedup of existing template inspectors |
| `packages/cli/src/audit/templates-audit-llm.ts` (new) | new    | LLM critique pass via `@shrkcrft/ai` (reuses `selectAiProvider`) |
| `packages/cli/src/__tests__/templates-audit.test.ts`  | new    | golden tests on a synthetic template fixture + `--no-enhance` end-to-end + mocked-provider merge |
| `docs/smart-context-audit-templates.md` (new)         | new    | usage + report-contract reference |

## Validation gate

```
bun x tsc -p tsconfig.base.json --noEmit
bun test packages/cli/src/__tests__/templates-audit.test.ts
bun test
shrk doctor
shrk check boundaries
bun run release:preflight
```

## Open items resolved during grounding

- LLM pipeline plumbing: `@shrkcrft/ai` — `selectAiProvider`,
  `EnhancementPipeline`, `OllamaProvider`, `buildPromptMessages`. Already
  used by smart-context.
- Templates inspection primitives: present in `packages/templates/*` and
  exposed via the `templates *` commands. We import the underlying
  functions, not spawn subprocesses.
- Saved-entries store: `.sharkcraft/smart-context/<slug>.{md,json}`.
  Existing pattern via `saveEnvelope` in `smart-context.command.ts`.
  Audit reports reuse the same store with an `audit-` prefix on the
  slug so they're easy to filter.

## Out of scope for v1

- Pack-contributed templates.
- Auto-fix / plan emission.
- Usage signal (no reliable source yet — needs its own round).
- Polish / second LLM pass.
- A new `audit` group across other constructs (rules, paths, pipelines).
  If wanted later, `smart-context audit-templates` becomes one of many
  `smart-context audit-*` siblings without breaking shape.
