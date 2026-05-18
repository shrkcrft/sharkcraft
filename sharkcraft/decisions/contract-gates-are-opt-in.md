---
id: contract-gates-are-opt-in
title: Contract gates are opt-in but strict when used
status: accepted
date: 2026-05-15
---

# Contract gates are opt-in but strict when used

## Context

Contract gates (R24) gate `shrk apply` on a human approval of the
generated contract. Making contract gating mandatory would block the
fast path of "scaffold a small thing and apply it"; making them weak
when active would defeat their purpose.

## Decision

Contract gates are opt-in via `--contract` / a configured task contract.
When active they are strict: a missing or expired approval *blocks*
apply with a clear "approve this contract first" message. No silent
pass-through.

## Consequences

- Low-risk work (templates, scaffolds, docs) keeps a frictionless path.
- High-risk work (architecture changes, lifecycle helpers, lifecycle
  removals) opts in to gating once and gets enforced consistently.
- Bypassing the gate requires a hard CLI flag and is policy-recorded.

## Related policies

- sharkcraft.contract-gate-opt-in-but-strict-when-used
- sharkcraft.no-destructive-without-approval

## Related commands

- shrk contract check
- shrk contract approve
- shrk apply --contract <id>
