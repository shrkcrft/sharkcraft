# Self-config doctor (R33 v1 / R38 v2)

`shrk self-config doctor` walks the *graph* of cross-references inside
the workspace + pack contributions and reports broken links, duplicate
ids, missing referenced ids, and stale pack signatures.

## Commands

```bash
shrk self-config doctor [--schema v1|v2] [--format text|markdown|json] [--strict]
shrk self-config graph [--format json|mermaid|dot]
shrk self-config broken-links [--json]
shrk self-config report [--schema v1|v2] [--output <dir>]
```

`--strict` returns a non-zero exit code on **any** warning (not just
errors). `--schema v1` opts back into the legacy R33 report shape; the
default is v2.

## R38 — v2 schema (`sharkcraft.self-config-doctor/v2`)

Each finding carries:

- `id` — stable identifier `sourceKind:sourceId|relation|targetKind:targetId`.
- `severity` — `info` / `warning` / `error`.
- `code` — finding code (e.g. `agent-test-helper-missing`).
- `sourceKind` / `sourceId` — the entity *referencing*.
- `targetKind` / `targetId` — the entity being referenced.
- `relation` — `references` / `expects` / `validates` / `requires` /
  `produces` / `routes-to` / `tunes` / `documents` / `supersedes` /
  `related`.
- `file` — optional originating file.
- `message`, `suggestedFix`, `nextCommand`.
- `confidence` — `high` (loader-backed) / `medium` / `low` (regex /
  fallback).

v2 adds these cross-reference checks v1 did not perform:

- agent-tests → helpers / playbooks / policies / commands
- policies → rules / commands / paths
- pipelines → templates / commands
- playbooks → templates / pipelines
- registration hints → templates / conventions / profiles
- decisions → rules / policies / files (prose tokens filtered out)

## What it checks

- Knowledge entries → file references resolve on disk.
- Knowledge entries → command / anchor / symbol references (delegated
  to `shrk knowledge stale-check`).
- Search-tuning `boostIds` / `taskHints.boostIds` resolve to a known
  knowledge / template / pipeline / contract template / lifecycle
  profile / convention id.
- Agent-test `expectedKnowledge` / `expectedTemplates` ids exist.
- Pack contribution conflicts (duplicate ids / shadowed / invalid /
  missing-loader / stale-signature).

## MCP

- `get_self_config_doctor` — read-only report.
- `get_self_config_graph` — read-only graph (nodes + edges +
  brokenEdges; supports `json | mermaid | dot` render via CLI).

## Schemas

- `sharkcraft.self-config-doctor/v1`
- `sharkcraft.self-config-graph/v1`
