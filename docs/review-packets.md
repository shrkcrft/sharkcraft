# PR review packets

`shrk review` builds a deterministic packet for an AI PR reviewer (or a
human) from a git diff selection.

```bash
shrk review --since HEAD~1
shrk review --staged
shrk review --files src/services/profile.ts,tests/profile.spec.ts
shrk review --json
```

The packet includes:

- Changed files (from `git diff --name-only [...]`).
- Affected path conventions.
- Relevant rules / templates / pipelines (via the deterministic ranker).
- Boundary violations restricted to the changed files.
- Missing-test heuristic (`src/x.ts` ⇒ `tests/x.spec.ts`).
- Verification commands (`shrk doctor`, `shrk check boundaries`, …).
- An `reviewerInstructions` block intended for an AI reviewer.

MCP: `get_review_packet`. Read-only — the reviewer never writes code.
