# Rounds (R58)

`shrk rounds` and `shrk diff rounds` answer "what shipped in R<n> vs
R<n-1>?" without scraping git logs. Round snapshots live under
`.sharkcraft/rounds/<id>/` and capture the engine surface at HEAD:
registered CLI commands, registered MCP tools, and top-level docs.

## Verbs

### `shrk rounds capture --id <id> [--title <text>] [--json]`

Snapshots the current surface and writes:

- `.sharkcraft/rounds/<id>/snapshot.json` — full surface payload
- `.sharkcraft/rounds/<id>/meta.json` — id, title, capturedAt

Schema: `sharkcraft.round-snapshot/v1`.

### `shrk rounds list [--json]`

Lists the round ids you have captured.

### `shrk rounds show <id> [--json]`

Prints one snapshot (counts in text mode; full payload in JSON).

### `shrk diff rounds --from <id> --to <id> [--json]`

Loads both snapshots and computes the delta:

- `commandsAdded[]`, `commandsRemoved[]`
- `mcpToolsAdded[]`, `mcpToolsRemoved[]`
- `docsAdded[]`, `docsRemoved[]`

Schema: `sharkcraft.rounds-diff/v1`.

## Workflow

```bash
# At the end of every round:
shrk rounds capture --id R<n> --title "<theme>"

# Anytime later:
shrk diff rounds --from R<n-1> --to R<n>
```

A missing round id returns a structured error envelope under `--json`
(`{ ok: false, error: 'round-not-found', missing: '<id>' }`) — never a
crash.

## What snapshots do *not* include

Snapshots are deliberately surface-only. They do not capture:

- Test counts or coverage deltas
- Package versions or dependency changes
- File-level diffs

For those, use the existing tooling (`bun test`, `git diff`, the
release-preflight chain). The round verb's job is to answer "what
*tools* did this round add or remove?", not to summarise every commit.

## Schemas

- `sharkcraft.round-snapshot/v1`
- `sharkcraft.rounds-diff/v1`

Both are stable; future rounds will not change the shape without
bumping the version.
