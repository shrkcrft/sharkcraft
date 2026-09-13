# Pack quality score — retired

> **Retired.** The `shrk packs score`, `shrk packs quality` and
> `shrk packs quality-diff` verbs were removed. Pack health is gated by
> `shrk packs doctor` (add `--release` to fold in the release checks) and
> `shrk packs release-check`. The notes below describe what the removed
> score measured, for reference.

The removed score was 0–100 per pack across weighted dimensions:

- Manifest validity
- Signature status
- Contribution loadability
- Docs presence
- Templates / pipelines quality (via lint summaries)
- Action hints coverage
- Duplicate-id guard

`shrk packs doctor` continues to enforce manifest validity / signatures; the
score is informational guidance for pack maintainers.

## Quality delta (R20) — removed with the score

The snapshot capture / compare verbs were removed with the score. Their
output shape (`sharkcraft.pack-quality-diff/v1`) was:

- `delta` — overall score delta (signed integer)
- `dimensionDeltas[]` — per-dimension `{ id, oldScore, newScore, delta }`
- `added[]` / `removed[]` — newly-introduced or retired dimensions
- `signatureChange` — when the signature state flips between snapshots
