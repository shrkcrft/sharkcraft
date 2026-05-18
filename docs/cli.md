# CLI Reference

## Commands

| Command | Description |
|---|---|
| `shrk init` | Create a `sharkcraft/` folder in the current repo |
| `shrk inspect` | Inspect project (frameworks, package manager, sharkcraft setup) |
| `shrk doctor` | Validate setup (config, knowledge, templates) |
| `shrk knowledge list` | List knowledge entries |
| `shrk knowledge get <id>` | Show one entry with full content |
| `shrk knowledge search <q>` | Search knowledge |
| `shrk rules list` | List rules |
| `shrk rules get <id>` | Show one rule |
| `shrk rules relevant --task "<t>"` | Relevant rules for a task |
| `shrk paths list` | List path conventions |
| `shrk paths get <id>` | Show one path convention |
| `shrk paths search <q>` | Search path conventions |
| `shrk paths best --task "<t>"` | Best path for a task |
| `shrk templates list` | List templates |
| `shrk templates get <id>` | Show one template |
| `shrk templates search <q>` | Search templates |
| `shrk templates preview <id> --var key=value` | Preview template |
| `shrk context --task "<t>"` | Token-budgeted AI context |
| `shrk gen <templateId> [<name>] --dry-run` | Generation plan |
| `shrk gen <templateId> [<name>] --write` | Apply plan (requires no conflicts) |
| `shrk gen <templateId> [<name>] --save-plan <file>` | Save the plan as JSON (sharkcraft.plan/v1) for later `shrk apply` |
| `shrk apply <plan.json>` | Apply a saved plan. The CLI is the only write path; MCP never writes. |
| `shrk ask "<question>"` | Send context+question to Claude (needs ANTHROPIC_API_KEY) |
| `shrk mcp serve` | Start the MCP server over stdio |
| `shrk dashboard` | Start the local read-only dashboard UI + API (GET/HEAD only; 127.0.0.1) |
| `shrk dashboard serve --port 4567 --no-open` | Same as above (explicit subcommand alias) |
| `shrk onboard adopt status` | Inspect adoption patch freshness |
| `shrk onboard adopt regenerate` | Rebuild adoption patch; archives previous under history/ |
| `shrk onboard adopt merge-preview --format markdown` | Preview what would merge without applying |
| `shrk onboard adopt check` | Validate the adoption patch can be applied |
| `shrk onboard adopt report --format html` | Render the adoption report |
| `shrk report <adoption\|session\|quality\|safety\|review\|coverage\|drift\|graph>` | Render any runtime report |
| `shrk scaffolds list / get / doctor / match` | Inspect pack-provided scaffold patterns |
| `shrk infer templates --ast` | AST/lightweight template body inference |
| `shrk schemas list / get / write` | Export JSON Schemas (envelope, adoption-state, etc.) |
| `shrk commands doctor` | Validate the command catalog invariants |
| `shrk safety audit --json` | Auditable safety report |
| `shrk version` | Print version |

All commands support `--json` for machine-friendly output where it makes sense.

The complete catalogue (84 entries with safety levels) is available via
`shrk commands --json` or `GET /api/commands` once the dashboard is running.
See `docs/command-catalog.md` for the curated catalogue model.

## Variables for templates

Repeated `--var key=value` flags supply template variables:

```bash
shrk gen typescript.service user-profile --var className=UserProfileService --dry-run
```

`shrk gen` and `shrk templates preview` also accept a positional `<name>` which auto-fills common derived variables (`kebab`, `pascal`, `camel`, `snake`, `className`, `fileName`).

## Plan format (`sharkcraft.plan/v1`)

`shrk gen --save-plan <file>` writes a JSON document like:

```json
{
  "schema": "sharkcraft.plan/v1",
  "templateId": "typescript.service",
  "name": "user-profile",
  "variables": { "className": "UserProfileService" },
  "projectRoot": "/abs/path/to/repo",
  "createdAt": "2026-05-11T21:07:00.411Z",
  "expectedChanges": [
    { "type": "create", "relativePath": "src/services/user-profile.service.ts", "sizeBytes": 79 }
  ]
}
```

`shrk apply <plan.json>` reads this back, **regenerates** the plan against the
current templates + project state, refuses to write if the plan has conflicts,
and writes only after verifying the live plan matches the saved
`expectedChanges`. Pass `--allow-divergent` to apply the live plan even when
the file list / sizes changed since save time, or `--force` to also allow
overwriting existing files.

This is the recommended workflow when an MCP agent has produced a plan: the
agent writes the JSON via its normal file-writing tools (or the user pastes
the MCP response into a file), then runs `shrk apply` to enact it. **MCP
never writes files.**
