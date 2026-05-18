---
id: knowledge-is-verifiable-not-tribal
title: Knowledge entries are verifiable, not tribal
status: accepted
date: 2026-05-15
---

# Knowledge entries are verifiable, not tribal

## Context

Knowledge entries describe project facts: "the renderer pipeline lives
here," "use `bun test` not `jest`," etc. Without verification, these
entries rot — a function gets renamed, a file gets moved, and the
knowledge silently becomes wrong.

## Decision

Knowledge entries SHOULD declare structured `references[]` and
`anchors[]` for the artefacts they reference. R29 adds:
  - `IKnowledgeReference` — `file | directory | symbol | command |
    template | playbook | construct | helper | policy | boundary-rule |
    path-convention | package | url`.
  - `IKnowledgeAnchor` — named points (`file`, `symbol`, `command`,
    `construct`, `template`, `helper`, `playbook`, `policy`).

`shrk knowledge stale-check` is the standing verification. It runs
against the workspace deterministically — no network, no AI.

## Consequences

- Knowledge entries that don't declare references still load (backwards
  compatible). They simply skip stale verification.
- A rename advisory (`shrk knowledge rename-symbol`) can propose
  updates instead of forcing a manual hunt.
- A "stale-check" gate in CI catches knowledge drift early.

## Related policies

- sharkcraft.template-drift-must-be-detectable

## Related commands

- shrk knowledge stale-check
- shrk knowledge references <id>
- shrk knowledge rename-symbol
- shrk knowledge rename-file
