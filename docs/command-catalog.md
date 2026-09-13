# Command catalog

`shrk commands` lists every command with its safety level, side effects,
and MCP availability. It is the canonical reference when you are writing
an agent that needs to decide which CLI command to surface.

```bash
shrk commands                       # full catalog grouped by category
shrk commands --safety read-only
shrk commands --category dev
shrk commands search "boundary"
shrk commands tree                  # group by top-level verb
shrk commands --json
```

## Safety levels

| Level                | Meaning                                                                 |
|----------------------|-------------------------------------------------------------------------|
| `read-only`          | Reads project state; no filesystem writes; no shell execution           |
| `writes-session`     | Writes only inside `.sharkcraft/sessions/<id>/`                         |
| `writes-drafts`      | Writes only under `sharkcraft/<draft-dir>/` — never live config         |
| `writes-source`      | Writes source files. Requires human review.                             |
| `runs-shell`         | Runs configured shell commands (e.g. `dev validate`)                    |
| `requires-review`    | Should not be invoked without an explicit human approval                |

The MCP server is **read-only** by design: every MCP tool's safety level is
`read-only`, and every "writes" command surfaces a `nextCommand` hint
pointing to the equivalent CLI command instead of performing the write.
The dashboard is also read-only: it serves the catalog as `GET /api/commands`
and renders every entry as a copyable `<CommandBlock>` — no button on the
dashboard ever executes a command.

## Audience

`intendedAudience` says who a command is for: `human`, `agent`, `ci`,
`pack-author`, `maintainer`, and (round 11) `tool-maintenance`. The default is
`human` (+ `agent` when `mcpAvailable`). `shrk surface list` prints it as a
column and `surface explain` as a line.

`tool-maintenance` is the one value with behaviour: the command's object is
SharkCraft ITSELF (its docs set, examples, release artifacts, command catalog,
round snapshots). Outside SharkCraft's own repository (`detectSharkcraftRepo`)
such a row resolves with tier source `tool-maintenance`: hidden from `--help`
and refused by the surface gate with exit 78 ("maintains SharkCraft itself and
does not apply to this repository — this is not a check failure");
`surface.enabled` is the escape hatch. See
[surface-tiers.md](./surface-tiers.md#tool-maintenance-commands-round-11).
`isToolMaintenance(row)` is the predicate; tag a new row that maintains the
tool itself with `CommandAudience.ToolMaintenance`.

## MCP

The same catalog is available via the MCP tool `get_command_catalog`:

```jsonc
{ "safetyLevel": "read-only" }      // filter by safety level
{ "category": "dev" }               // filter by category
```

## Doctor

```bash
shrk commands doctor              # text output
shrk commands doctor --json       # JSON for CI / agents
```

Asserts invariants:

- every catalog entry has description / category / safety level
- writes-source ⇒ not mcpAvailable
- writesSource ⇒ writesFiles
- runs-shell safety level ⇒ runsShell=true
- registered commands are present in the catalog
- catalog commands map to a registered top-level (or known group)
- every registered command has a non-empty usage string
- **`registry-path-not-in-catalog`** (warning, round 11) — every dispatchable
  path in the command index (`shrk surface list`) has a catalog row, at PATH
  granularity. The older checks compared top-level handlers only, so 75
  registered 2-level paths (`knowledge list`, `gates check`, …) with no row —
  and so no safety metadata — read as "OK ✓". Its count equals
  `surface list`'s `totals.uncatalogued`.
- **`undeclared-internal-subverb`** (error, round 11) — a catalog row documents
  a subverb of a handler that DECLARES its subverbs (`ICommandHandler.subverbs`)
  but not that one. Handlers that declare nothing are not checked.

Exit code is non-zero if any **error**-severity issue is detected. The clean
verdict is settled against the path-level pass's coverage (every registered
path examined); `--json` carries `coverage`, `exitCode` and `shortfalls`.

## The command index

`packages/cli/src/surface/command-index.ts` (`buildCommandIndex(registry)`) is
the ONE inventory of what dispatches: every registered handler path, every
declared or catalog-documented subverb, and the meta flags, joined with this
catalog by clean path (flag-variant rows fold into `variants`). `surface list`,
`help`, `commands doctor`, the surface gate and the command-string resolver
(`resolveCommandString`) all read it; nothing else walks COMMAND_CATALOG to
answer "does this command exist".

## Tests

`packages/cli/src/__tests__/command-catalog.test.ts` asserts:

- every entry has a non-empty `command` and `description`
- there are no duplicate `command` keys
- every entry has a known safety level
- the MCP-side catalog matches the CLI-side catalog (same `command` set)
