---
id: plan-v2-no-delete-op
title: Plan v2 has no delete-file / rename-folder op
status: accepted
date: 2026-05-15
---

# Plan v2 has no delete-file / rename-folder op

## Context

R28 introduced plugin lifecycle helpers (`shrk plugin rename`, `shrk plugin
remove`). The natural design was to add `delete-file` and `rename-folder`
operations to the plan engine.

We chose not to.

## Decision

The plan v2 operation set is intentionally limited to:
  - `create` (new file)
  - `append`, `insert-after`, `insert-before` (mutations inside a file)
  - `replace` (textual replace)
  - `export` (barrel export op)

Deleting a file or renaming a folder is *not* a plan operation. Instead,
helpers emit a structured `manualSteps` checklist with `kind:
'delete-folder'` or `kind: 'rename-folder'`, and the human runs `git mv`
/ `git rm -r` themselves.

## Consequences

- Destructive folder operations stay in human hands. A plan can be
  applied automatically; a destructive checklist cannot.
- Lifecycle helpers are robust to "I changed my mind" — the human can
  skip the manual step and only the plan's edit ops apply.
- Adding a `delete-file` operation requires a follow-up ADR that
  supersedes this one and explicitly addresses approval flow.

## Related policies

- sharkcraft.no-destructive-without-approval
- sharkcraft.plan-v2-no-hidden-side-effects

## Related commands

- shrk plugin remove
- shrk plugin rename
- shrk apply
