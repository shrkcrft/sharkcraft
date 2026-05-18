---
id: template-drift-checks-before-trust
title: Templates must pass drift verification before trust
status: accepted
date: 2026-05-15
---

# Templates must pass drift verification before trust

## Context

Scaffolded template paths must be re-verified after large refactors:
template paths can silently drift when a pack contributor updates
their templates and the path conventions of the consumer repo evolve.
Without a drift check, that regression class recurs.

## Decision

`shrk templates drift` is the standing check. It verifies:
  - forbidden legacy fragments (e.g. `contracts/<name>` in a layered
    monorepo).
  - missing barrels referenced by `export` ops.
  - missing anchors for insert ops.
  - unresolved related ids.

Packs SHOULD run `shrk templates drift --pack <packId>` as part of
their release flow. The CI is otherwise free to run it as a soft
gate.

## Consequences

- Path-fragment regressions get caught by a deterministic check.
- The drift report is a first-class artefact for review.
- Templates that intentionally use a non-conventional path get an
  explicit suppression / pack-doctor entry rather than silent drift.

## Related policies

- sharkcraft.template-drift-must-be-detectable

## Related commands

- shrk templates drift
- shrk templates verify-paths
- shrk templates smoke
