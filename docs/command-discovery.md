# Command discovery & did-you-mean

R31 adds typo-tolerant command discovery so users stop grepping `main.ts`
to find a command.

## Commands

```bash
shrk commands suggest "<partial>" [--limit N] [--safe-only] [--mcp-safe-only] [--category <category>] [--json]
shrk commands search  "<query>"   [--json]
shrk commands explain "<command-or-partial>" [--json]

shrk commands profile             # list surface profiles + how many each hides
shrk commands profile <id>        # render the catalog as that profile sees it
shrk commands --profile <id>      # same curated view as a flag (e.g. agent)

shrk help <group>           # lists nested subcommands for the group
shrk <group> --help         # same effect
```

Unknown top-level commands and unknown subcommands print a short
"Did you mean: …" block. The CLI never executes the suggested command —
the human runs it.

## Curated views (`--profile`)

The full catalog has hundreds of callable commands, many of which are
CI / release / pack-maintenance machinery that is noise for an inline
coding agent. `shrk commands --profile <id>` filters the listing to the
surface a [surface profile](profiles.md) sees — e.g. `--profile agent`
hides interactive verbs plus CI/release/pack-maintenance categories,
leaving the read/scaffold/validate surfaces an agent actually uses.

Hiding is **listing-only** — every command stays fully callable; the
profile just curates what is shown. The view derives its hidden set
mechanically from the catalog (via `packages/cli/src/surface/profiles.ts`),
so it never drifts as commands are added or removed. `--json` emits
`{ profile, total, catalogTotal, hiddenCount, hidden, entries }`.

## How matching works

Deterministic Levenshtein + token-fragment scoring (see
`packages/inspector/src/command-suggester.ts`). The score sums:

- exact substring of the full command (10)
- exact / near-match command token (5–8)
- description token match (1–2)

## MCP

- `suggest_commands` — read-only.
- `search_commands` — read-only.
- `explain_command` — read-only.

## Example

```bash
$ shrk commands suggest "feed rules"
[20] feedback rules              read-only  List + validate pack-contributed feedback rules.
[10] feedback                    read-only  R29 feedback ingestion.
```
