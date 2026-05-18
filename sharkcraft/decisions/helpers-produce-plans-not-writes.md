---
id: helpers-produce-plans-not-writes
title: Helpers produce plans, never writes
status: accepted
date: 2026-05-15
---

# Helpers produce plans, never writes

## Context

R28 added `shrk helper plan <id>` and the helper registry. The helpers
do repetitive small edits (add a barrel export, add a plugin key entry,
update a barrel). The temptation: skip the plan layer and have helpers
mutate source directly.

## Decision

Every helper emits a `sharkcraft.helper-plan/v1` plan. The plan contains
plan-v2 operations and an optional manual-steps checklist. Helpers
*never* write source themselves. To apply the plan, the human runs
`shrk apply <plan.json>`.

The corresponding MCP tools (`preview_helper_plan`, etc.) are read-only.

## Consequences

- Helpers are composable — they slot into pipelines that already speak
  plan-v2.
- Review gates (contract, boundary, plan simulation) apply to helper
  output naturally.
- Adding a "helper that writes directly" requires an explicit ADR and
  an apply policy revision.

## Related policies

- sharkcraft.helper-preview-only-mcp

## Related commands

- shrk helper list
- shrk helper plan <id>
- shrk apply
