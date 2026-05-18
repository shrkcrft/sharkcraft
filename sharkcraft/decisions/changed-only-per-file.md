---
id: changed-only-per-file
title: Changed-only filtering operates per-file, not per-package
status: accepted
date: 2026-05-15
---

# Changed-only filtering operates per-file, not per-package

## Context

R28 introduced `--changed-only` boundaries. R29 generalises that into a
shared `IChangedScopeClassification`. The choice was: filter findings by
file path, or filter by package/module.

## Decision

The scope set is **a set of changed files**. A finding is "in scope" iff
its file path is in that set (or is a path-tail match for one of the
files). Package-level filtering is not implemented.

## Consequences

- Findings that exist in a changed file but were not in the baseline are
  `new-in-changed-file` and fail the check.
- Findings in *untouched* files in the same package as a changed file
  are still hidden — this is the right call for the "did *I* introduce
  this?" question.
- Aggregations (count per package, etc.) are downstream views over the
  per-file classification.

## Related policies

- (none directly — supported by the shared `changed-scope` schema.)

## Related commands

- shrk check boundaries --changed-only
- shrk policy run --changed-only
- shrk drift --changed-only
- shrk knowledge stale-check --changed-only
