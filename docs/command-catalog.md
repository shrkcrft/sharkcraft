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

Exit code is non-zero if any **error**-severity issue is detected.

## Tests

`packages/cli/src/__tests__/command-catalog.test.ts` asserts:

- every entry has a non-empty `command` and `description`
- there are no duplicate `command` keys
- every entry has a known safety level
- the MCP-side catalog matches the CLI-side catalog (same `command` set)
