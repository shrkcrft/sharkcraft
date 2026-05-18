# Pack quality score

```bash
shrk packs score [<pkg>] [--json]
shrk packs quality <path> [--strict] [--json]
```

Returns a 0–100 score per pack across weighted dimensions:

- Manifest validity
- Signature status
- Contribution loadability
- Docs presence
- Templates / pipelines quality (via lint summaries)
- Action hints coverage
- Duplicate-id guard

`shrk packs doctor` continues to enforce manifest validity / signatures; the
score is informational guidance for pack maintainers.

## Quality delta (R20)

Capture and compare quality snapshots so regressions show up in CI:

```bash
# Capture
shrk packs quality <path> --write-snapshot pack-quality-old.json

# Diff against a captured snapshot
shrk packs quality <path> --snapshot pack-quality-old.json

# Or diff two stand-alone snapshots
shrk packs quality-diff pack-quality-old.json pack-quality-new.json
```

Output (`sharkcraft.pack-quality-diff/v1`):

- `delta` — overall score delta (signed integer)
- `dimensionDeltas[]` — per-dimension `{ id, oldScore, newScore, delta }`
- `added[]` / `removed[]` — newly-introduced or retired dimensions
- `signatureChange` — when the signature state flips between snapshots
