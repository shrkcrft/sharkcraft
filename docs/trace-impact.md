# Fuzzy trace + impact (R29)

R29 adds a top-level `shrk trace <query>` that resolves any free-form
query against multiple registries — files, constructs, knowledge,
templates, helpers, playbooks, policies, commands, symbols, and
pack-contributed plugin keys.

## Commands

```
shrk trace <query> [--limit <n>] [--kind file|construct|knowledge|template|helper|playbook|policy|command] [--deep] [--json]
shrk impact <file-or-specifier>    # unchanged from R27/R28
```

## Confidence

`exact | high | medium | low | unknown`. Above `medium`, the best
match is reliable enough for the agent to act on without further
disambiguation.

## `--deep`

Prints follow-up commands tailored to the best match's kind:

| best match kind | follow-up |
|---|---|
| `construct` | `shrk constructs trace <id> --deep`, `shrk constructs impact <id> --json` |
| `file` | `shrk impact <file>` |
| `knowledge` | `shrk knowledge get <id>` |
| `template` | `shrk templates preview <id>` |
| `helper` | `shrk helper plan <id>` |
| `playbook` | `shrk playbooks runbook <id>` |
| `policy` | `shrk policy get <id>` |
| `command` | `shrk commands get <id>` |

## Schema

`sharkcraft.query-resolution/v1` — `bestMatch`, `alternatives[]`,
`confidence`, plus per-match `kind`, `id`, `label`, `score`, `reason`.

## MCP

- `resolve_query({ query, limit?, kinds? })`
- `trace_query({ query, limit?, kinds? })` — alias.

Both read-only.

## R30 — Fuzzy impact

`shrk impact <query>` accepts the same fuzzy queries as `shrk trace`.

```
shrk impact <query>                         # auto-runs on exact / high match
shrk impact <query> --resolve-only          # don't run impact; just report
shrk impact <query> --explain-resolution    # prefix output with the resolution block
shrk impact <query> --no-resolve            # disable fuzzy resolution; legacy file behaviour
shrk impact <query> --json                  # JSON output includes the resolution
```

| Resolved match kind | Impact source | Notes |
|---|---|---|
| File | exact-file | Same as R27 file impact |
| Construct | construct | Construct's `files[]` (warmed via `warmConstructCache`) |
| PluginKey / EventToken / DIToken | plugin-key / event-token / di-token | Mapped back to the construct that declares the facet |
| Symbol | symbol | Best-effort symbol-to-construct lookup |
| Template | template | `targetPath` if it resolves to a real file |
| Helper | helper | Helper output paths |
| Playbook | playbook | Playbook-related files |
| Knowledge | knowledge | `references[]` of kind `file` |
| Command | command | No impact target — surfaces next-command hint |

Schema: `sharkcraft.fuzzy-impact-resolution/v1`.

### Ambiguous results

When the best match is below high confidence, impact does **not** auto-run.
The CLI surfaces alternatives and a list of follow-up commands; exit code is 1.

### MCP

- `get_fuzzy_impact_report({ query, limit?, resolveOnly? })` — read-only.
