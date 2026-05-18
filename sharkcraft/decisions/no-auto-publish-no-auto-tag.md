---
id: no-auto-publish-no-auto-tag
title: No auto-publish, no auto-tag
status: accepted
date: 2026-05-15
---

# No auto-publish, no auto-tag

## Context

SharkCraft publishes npm packages and tags releases. An automated path
("on merge to main, publish + tag") is tempting. The risk: a buggy
build, a misconfigured pack, or a missing safety review ships before a
human notices.

## Decision

Release is human-gated. `shrk release readiness --strict` produces a
verdict; tagging and publishing require explicit human action. The
preflight scripts (`bun run release:preflight`, `bun run publish:dry-run`,
`bun run release:smoke-test`) are dry-runs.

`shrk apply` likewise never publishes; it only writes to local files.

## Consequences

- Releases are slower but auditable.
- A wrong-tag-on-CI incident requires malicious intent, not just a bad
  merge.
- Automating any part of release requires a hard ADR that names the
  gates and approver.

## Related policies

- (none directly — runtime gate.)

## Related commands

- shrk release readiness --strict
- bun run release:preflight
- bun run publish:dry-run
