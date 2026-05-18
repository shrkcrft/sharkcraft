---
id: pack-assets-are-contracts
title: Pack assets are contracts, not suggestions
status: accepted
date: 2026-05-15
---

# Pack assets are contracts, not suggestions

## Context

Packs ship rules, templates, paths, pipelines, presets, boundaries,
scaffold patterns, playbooks, agent tests, and search tuning. Each
asset is data the engine consumes deterministically. Treating these as
"suggestions" the engine could ignore would make pack behaviour
non-reproducible.

## Decision

Pack-contributed assets are contracts: when a manifest declares them,
the engine MUST honour the contract or surface a clear error.
Specifically:
  - manifest schema is zod-validated.
  - signed packs are verified before pack assets are used by `apply`.
  - pack-contributed verification commands are NOT auto-run; only
    config-trusted commands run.
  - pack contributions get audited by `shrk packs doctor --release`.

Breaking a pack contract is a SemVer-breaking change for that pack.

## Consequences

- Pack authors get a sharp contract to test against (`shrk packs test`).
- Consumer repos can trust signed packs to not silently change behaviour.
- Pack contributions cannot quietly bypass safety policies — the engine
  treats them as data, never as code.

## Related policies

- sharkcraft.helper-preview-only-mcp
- sharkcraft.no-destructive-without-approval

## Related commands

- shrk packs doctor --require-signatures
- shrk packs test --cases
- shrk packs sign
