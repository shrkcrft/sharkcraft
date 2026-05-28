Follow `.claude/skills/sharkcraft-dev/SKILL.md` from the first line.

# Round: audit-templates v3 — close the loop + deepen LLM usage across shrk

## Goal

Close the v2 loop against the real workspace, then make LLM the
sharpest tool in the box without compromising the deterministic
baseline. Five threads in one round:

1. **(A) Close the loop.** Apply the v2 fix plan against the engine's
   own `sharkcraft/templates.ts` and re-audit. Proves the prompts work
   as load-bearing instructions, not just well-formatted prose.
2. **(B) Deeper staleness detection.** Strengthen the LLM critique
   prompt to call out specific staleness signals: API drift,
   deprecated patterns, doc-vs-content mismatch, sibling-style drift.
   Extend the parser to recognize the new categories.
3. **(C) LLM-enriched fix plan.** When the LLM is reachable, layer
   concrete suggestions on top of each deterministic fix instruction —
   suggested example values, undeclared-var resolutions, path-convention
   gap recommendations. SharkCraft still never edits templates; the
   agent does.
4. **(D) Actionable AI-configuration hints.** Every audit (with or
   without LLM) surfaces a structured `ai` block telling Claude how to
   configure shrk for the best result: setup steps when no provider,
   upgrade hints when the provider is weak, "all good" when reachable.
5. **(E) Wire the LLM to other useful surfaces.** Add a shared
   `enrichWithLlmRecommendations` utility and wire it into:
   - `shrk doctor --llm-recommendations`
   - `shrk templates drift --llm-recommendations`

## Non-negotiable invariants

- **Deterministic baseline stays perfect.** Without any LLM, every
  command produces the same output it does today. LLM is purely
  additive — flagged into the result, never destabilising it.
- **No CLI writes to template sources.** Plan emission only. Claude
  applies via its own Edit tool.
- **`unsafe-target` never auto-fixed.** Already enforced; preserved.
- **MCP stays read-only.** No new MCP surfaces introduced in this round.

## Per-part scope

### (A) Close the loop — applied to `sharkcraft/templates.ts`

Apply the high/medium-confidence fixes the v2 plan produced for the
two engine templates:
- `engine.cli-command`: add `examples` for `name` + `description`,
  remove `typescript.files.one-export` from `related[]`.
- `engine.mcp-tool`: add `examples` for `name` + `description`.
Skip `path-no-convention` (info-only, cross-cutting; needs paths.ts
changes, not template changes).

Then re-run audit and confirm verdicts shift.

### (B) Deeper staleness detection

Extend the LLM critique prompt with explicit asks:
- API drift (does the rendered body import from paths/symbols that still exist?)
- Deprecated patterns (`var`, old TS syntax, removed helpers)
- Doc-content mismatch (does `description` accurately describe what `content` produces?)
- Sibling-style drift (does the body match recent peers' style?)

Allow new category labels in the parser: `api-drift`,
`deprecated-pattern`, `doc-content-mismatch`, `style-drift`,
`missing-variable`, `content-bug`, `stale-phrasing`, `other`.

### (C) LLM-enriched fix plan

New module `templates-fix-plan-llm.ts`: takes the plan + inspection,
calls the LLM once per template with that template's fixes batched.
Returns a plan where each fix gets an optional `llmSuggestion`
field — a concrete suggestion that sharpens the deterministic
`agentPrompt`. Examples:
- `required-var-no-example` → suggested concrete value
- `undeclared-var` → recommended add-or-remove resolution
- `path-no-convention` → suggested paths.ts entry to add

### (D) AI-configuration hints

New module `templates-audit-hints.ts` produces a structured `ai`
block included in every audit report (with or without LLM):

```
ai: {
  reachable: bool,
  requestedProvider: 'auto'|'ollama'|'llamacpp'|'claude'|'gemini',
  providerId: string|null,
  hints: [{ level: 'setup'|'upgrade'|'info', title: string, steps: string[] }]
}
```

Rendered into both Markdown and JSON output. Without LLM, hints
prescribe setup steps so Claude can self-configure shrk. With LLM,
hints reflect "good config" + any minor improvements (e.g., model
size, max-tokens).

### (E) Shared LLM-recommendations utility + wiring

`packages/cli/src/llm/llm-recommendations.ts` (new):
```ts
export async function enrichWithLlmRecommendations(input: {
  provider: IAiProvider | null;
  contextHeading: string;
  contextBody: string;        // human description of the deterministic findings
  ask: string;                // what to ask the LLM (per surface)
  maxTokens?: number;
}): Promise<{
  reachable: boolean;
  providerId: string | null;
  recommendations: IRecommendation[];
}>;
```

Plus a shared `buildAiConfigHints(selection)` so any command can
emit the same `ai` block as audit-templates.

Wire into `shrk doctor --llm-recommendations` and
`shrk templates drift --llm-recommendations` as additive flags.
Without the flag, output is unchanged.

## Hard guarantees (recap)

- Output without LLM is byte-stable for the deterministic portion.
- LLM enrichment is opt-in (audit-templates: default-on when reachable;
  doctor/templates drift: opt-in via explicit flag).
- AI block surfaces in every audit run, deterministic or not.
- No new MCP surfaces.

## File plan

| File | Action |
|---|---|
| `sharkcraft/templates.ts` | apply Part-A fixes |
| `packages/cli/src/audit/templates-audit-llm.ts` | extend prompt + accept new categories |
| `packages/cli/src/audit/templates-fix-plan-llm.ts` (new) | enrich fix plan with concrete LLM suggestions |
| `packages/cli/src/audit/templates-audit-hints.ts` (new) | structured AI-configuration hints |
| `packages/cli/src/audit/templates-audit.ts` | add `ai` field to `ITemplateAuditReport` |
| `packages/cli/src/audit/templates-fix-plan.ts` | add `llmSuggestion?` to `IFixInstruction` |
| `packages/cli/src/commands/smart-context.command.ts` | thread enrichment + hints + render |
| `packages/cli/src/llm/llm-recommendations.ts` (new) | shared LLM-recommendations utility |
| `packages/cli/src/commands/doctor.command.ts` | `--llm-recommendations` flag |
| `packages/cli/src/commands/templates.command.ts` | `--llm-recommendations` flag on `drift` |
| tests (multiple) | extend + add coverage for B, C, D, E |
| `docs/smart-context-audit-templates.md` | update with v3 sections |

## Validation gate

- `bun x tsc -p tsconfig.base.json --noEmit`
- `bun test packages/cli/src/__tests__/templates-*.test.ts`
- `bun test`
- `shrk doctor`
- `shrk check boundaries`
- Smoke: `shrk smart-context audit-templates --no-enhance` (deterministic-only
  output stable apart from the new `ai` block)
- Smoke: `shrk doctor --llm-recommendations` (no-op without LLM, only emits
  the hint block).

## Out of scope (this round)

- Actually applying fixes from the CLI. Plan emission only.
- `shrk templates lint --llm-recommendations` (defer to a follow-up; one
  surface per round keeps blast radius bounded — drift is the more
  important one).
- A new `shrk configure-ai` interactive setup. The hint block + docs
  cover the same need without a new command.
- Auto-recommended model selection.
