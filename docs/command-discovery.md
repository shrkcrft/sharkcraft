# Command discovery & did-you-mean

R31 adds typo-tolerant command discovery so users stop grepping `main.ts`
to find a command.

## Commands

```bash
shrk commands suggest "<partial>" [--limit N] [--safe-only] [--mcp-safe-only] [--category <category>] [--json]
shrk commands search  "<query>"   [--json]
shrk commands explain "<command-or-partial>" [--json]

shrk help <group>           # lists nested subcommands for the group
shrk <group> --help         # same effect
```

Unknown top-level commands and unknown subcommands print a short
"Did you mean: …" block. The CLI never executes the suggested command —
the human runs it.

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
