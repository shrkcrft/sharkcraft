---
id: ingest-adopt-stub-bodies
title: Ingest adopt writes stub bodies, not full implementations
status: accepted
date: 2026-05-15
---

# Ingest adopt writes stub bodies, not full implementations

## Context

`shrk ingest adopt` adopts a draft into the live SharkCraft config. By
default, the adopted entries get stub bodies (`// TODO: …`) instead of
the materialised content from the draft.

R28 added `--include-body` to optionally materialise the body when an
entry block can be safely extracted from the draft.

## Decision

Stub-by-default stays. `--include-body` is an explicit opt-in. The
extractor refuses to materialise when:
  - the entry id matches more than one block in the draft (conflict).
  - the brace-depth walk cannot resolve the enclosing object literal.

## Consequences

- The default adopt is safe even if the draft is noisy.
- Authors get a clear path to materialised entries via `--include-body`.
- Conflicts surface in the report; the human resolves them.

## Related policies

- sharkcraft.ingest-adopt-allowlist
- sharkcraft.no-destructive-without-approval

## Related commands

- shrk ingest adopt plan
- shrk ingest adopt plan --include-body
