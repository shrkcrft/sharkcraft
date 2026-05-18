---
id: memory-is-local-only
title: Memory is local-only — never network
status: accepted
date: 2026-05-15
---

# Memory is local-only — never network

## Context

SharkCraft maintains a per-repo memory index under `.sharkcraft/memory/`.
This contains risk signals derived from local history (`git log`,
diagnostics, ownership). The temptation: sync to a remote service.

## Decision

Memory is local-only. The memory subsystem:
  - reads only repo-local files.
  - writes only under `.sharkcraft/memory/`.
  - never makes a network request.

`shrk memory snapshots` archives within `.sharkcraft/memory/history/`.

## Consequences

- Memory is reproducible from local state alone.
- No network failure can break memory operations.
- A future "shared memory" feature requires a hard ADR that names the
  service, retention policy, and opt-in flow.

## Related policies

- sharkcraft.memory-local-only

## Related commands

- shrk memory build
- shrk memory drift
- shrk memory report
