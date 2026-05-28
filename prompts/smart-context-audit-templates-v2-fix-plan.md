Follow `.claude/skills/sharkcraft-dev/SKILL.md` from the first line.

# Round: `shrk smart-context audit-templates` v2 — Claude-targetable fix plan

## Goal

Extend the audit-templates command so it can emit a structured **fix
plan** alongside (or instead of) the audit report. The plan is a
machine-readable instruction set Claude executes against
`sharkcraft/templates.ts` via its own Edit tool. SharkCraft remains
write-free on this path — the CLI just emits the plan.

This is the second half of the original brief: "The claude can fix
them."

## Why

v1 produces a report that lists what's wrong but stops there. To
shrink the loop, Claude needs a precise, per-finding action list it
can execute one finding at a time without re-deriving the fix from
prose. A structured plan also makes the fixes auditable: which
findings get auto-fixed, which are advisory, which were skipped on
purpose (e.g. security-sensitive).

## Surface

```bash
shrk smart-context audit-templates --fix-plan                    # report + fix plan
shrk smart-context audit-templates --fix-plan --json             # JSON envelope with both
shrk smart-context audit-templates --fix-plan --only-plan        # emit just the plan
shrk smart-context audit-templates --fix-plan --save             # persist both report and plan
```

`--fix-plan` is a flag on the existing subcommand. The plan is derived
from the audit report, so the user pays for both in one invocation
(audit runs once, plan is built from its findings).

## Plan shape

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
      "agentPrompt": "Open sharkcraft/templates.ts. Find the template with id \"engine.cli-command\". In its `related` array, remove the string \"typescript.files.one-export\". Do not change anything else. Verify the file still parses.",
      "confidence": "high"
    }
  ],
  "skipped": [
    { "templateId": "x", "findingCategory": "unsafe-target", "reason": "security-sensitive — requires human review" }
  ],
  "summary": {
    "fixCount": 3,
    "highConfidence": 1,
    "mediumConfidence": 2,
    "lowConfidence": 0,
    "skipped": 1
  }
}
```

## Per-category dispatch

| Category | Action | Confidence | Notes |
|---|---|---|---|
| `unsafe-target` | **skip** | — | security-sensitive; requires human review |
| `missing-name` | fix | high | mechanical: add `name: '<TODO>'` |
| `missing-description` | fix | high | mechanical: add `description: '<TODO>'` |
| `related-id-unresolved` | fix | high | mechanical: remove the unresolved id from `related[]` |
| `undocumented-var` | fix | medium | requires writing a description |
| `required-var-no-example` | fix | medium | requires choosing a representative example |
| `undeclared-var` | fix | medium | judgment: add to `variables[]` or remove placeholder |
| `path-no-convention` | fix | low | cross-cutting: update template or paths.ts |
| any other deterministic category | fix | low | generic prompt: "review the finding and address it" |
| any LLM finding | fix | low | generic prompt: "advisory — review and act with judgment" |

Variable names / unresolved ids / paths are extracted from finding
messages via small, anchored regexes — the messages have stable shape
because they're produced by `lintTemplates` and
`buildTemplateDriftReport` in `@shrkcrft/inspector`.

## Hard guarantees (unchanged from v1)

- **CLI never writes to template sources.** Plan is emitted; Claude
  acts.
- **`unsafe-target` is never auto-fixed.** Always skipped with reason.
- **Offline-safe.** The plan is derivable from the report alone — no
  LLM needed to produce the plan itself.

## File plan

| File | Action |
|---|---|
| `packages/cli/src/audit/templates-fix-plan.ts` (new) | Pure builder: `buildFixPlan(report) → ITemplateFixPlan` |
| `packages/cli/src/commands/smart-context.command.ts` | Add `--fix-plan` / `--only-plan` flag handling; render plan to MD; save plan alongside report |
| `packages/cli/src/__tests__/templates-fix-plan.test.ts` (new) | Golden tests on each category's instruction shape + end-to-end via the command |
| `docs/smart-context-audit-templates.md` | Add "Fix plan" section |

## Validation gate

- `bun x tsc -p tsconfig.base.json --noEmit`
- `bun test packages/cli/src/__tests__/templates-fix-plan.test.ts`
- `bun test`
- `shrk doctor`
- `shrk check boundaries`

## Out of scope for v2

- Actually applying fixes from the CLI. The CLI emits, Claude applies.
- Producing a signed `shrk apply`-compatible plan (templates are
  TypeScript source files, not generated artifacts — the existing
  generator/apply pipeline isn't the right tool here).
- A "watch" loop that re-audits after Claude applies.
