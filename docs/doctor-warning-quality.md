# Doctor warning quality

R43 extended `IDoctorCheck` and the action-hint diagnostics so warnings
do not become permanent yellow noise. Every action-hint warning now
carries:

| Field | Purpose |
| --- | --- |
| `category` | Stable bucket (`action-hint-quality`, `pack-doctor`, …). Used by `--hide` and acknowledgements. |
| `code` | Stable per-finding code (`missing-verification`, `missing-write-policy`, …). Distinguishes related findings inside the same category. |
| `recommendedFix` | A copy-pasteable command (e.g. `shrk fix preview --action-hints --target <id>`). |
| `whyThisMatters` | A one-line explanation of the consequence of ignoring the finding. |
| `advisory` | True when the finding is for an advisory rule. |

## Default render

`shrk doctor` prints each warning with its code in parentheses and the
recommended fix indented underneath:

```
WARN  Action-hint quality (missing-verification) — "rule.x" should list verificationCommands so the agent can validate the result.
        fix: shrk fix preview --action-hints --target rule.x
```

Pass `--explain-quality` to surface the `whyThisMatters` line:

```
WARN  Action-hint quality (missing-verification) — "rule.x" should list verificationCommands so the agent can validate the result.
        fix: shrk fix preview --action-hints --target rule.x
        why: Enforceable rules need verificationCommands so `shrk apply --validate` and the agent can check the result.
```

Advisory rule findings get a `[advisory]` tag so they read as
informational rather than actionable.

## What "warning quality" means

A warning is in one of four states:

1. **Fixed** — the underlying issue is gone; doctor shows nothing.
2. **Acknowledged** — `shrk doctor acknowledge` recorded a reason +
   expiry. Visible in `shrk doctor acknowledgements` but suppressed
   from the headline.
3. **Suppressed** — `sharkcraft/doctor.suppressions.json` carries an
   entry without expiry. Less rigorous than acknowledgement; doctor
   still reports the suppressed count.
4. **Advisory** — the rule itself is marked `metadata.advisory: true`,
   so the warning is informational and not requiring action.

R43 does not add a new persistence layer. The acknowledgement /
suppression model already established in R29 / R38 still applies.

## Acknowledgement workflow

```bash
shrk doctor acknowledge --code missing-verification \
  --reason "tracked in INGEST-123, due 2026-06" \
  --expires-in 7d
shrk doctor acknowledgements         # show active / expiring soon / expired
shrk doctor acknowledgements --json
```

Expired acknowledgements surface in the doctor output so they don't go
stale silently.

## Hard rules

- Doctor never hides a warning by default. `--hide <category>` and
  `--quiet-known` filter the headline view; the suppressed count is
  still reported.
- Errors are not suppressed unless the suppression entry sets
  `allowError: true`.
- The advisory marker on a rule never silences anything other than the
  per-rule findings (`missing-verification` / `missing-commands-or-mcp`
  / `missing-forbidden-actions` / `missing-hints`).

## See also

- `docs/rule-authoring.md` — `metadata.advisory: true` for advisory rules.
- `packages/inspector/src/doctor-suppressions.ts` — the suppression engine.
- `packages/inspector/src/doctor-acknowledgements.ts` — the acknowledgement
  layer (R38).
