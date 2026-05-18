# Adoption checkpoints

R15 adds **adoption checkpoints** for both `shrk onboard adopt` and
`shrk constructs adopt`. A checkpoint records the hashes of the proposed
diff, the draft files, and the live target files at the moment the user
last accepted a state. Subsequent `status` calls can then report whether
anything has drifted since then.

## What a checkpoint contains

```json
{
  "schema": "sharkcraft.adoption-checkpoint/v1",
  "kind": "onboard",
  "generatedAt": "2026-05-13T22:42:51.746Z",
  "command": "shrk onboard adopt --write-patch",
  "diffHash": "…",
  "patchHash": "…",
  "targetHashes": {
    "sharkcraft/rules.ts": "<sha256>",
    "sharkcraft/paths.ts": "(missing)"
  },
  "draftHashes": {
    "sharkcraft/onboarding/inferred-rules.draft.ts": "<sha256>"
  }
}
```

Checkpoints live alongside the existing adoption outputs:

- `sharkcraft/onboarding/adoption/adoption-checkpoint.json`
- `sharkcraft/construct-drafts/adoption/adoption-checkpoint.json`

## Recording a checkpoint

Two ways:

```bash
shrk onboard adopt --write-patch              # auto-records on success
shrk constructs adopt --write-patch           # auto-records on success
shrk onboard adopt diff --record-checkpoint   # record without writing a patch
shrk constructs adopt diff --record-checkpoint
```

The "record after diff" form is useful for "I just reviewed the diff and
this is the version I'm pinning right now" — even when the user doesn't
want a patch yet.

## Reading checkpoint status

```bash
shrk onboard adopt status
shrk constructs adopt status
```

Both surface a `checkpoint:` line with one of:

| Status              | Meaning |
|---------------------|---------|
| `up-to-date`        | drafts, targets, and diff hash all match the checkpoint |
| `stale-draft`       | a draft file changed since the checkpoint |
| `stale-target`      | a live target file (e.g. `sharkcraft/rules.ts`) changed |
| `stale-diff`        | the rendered diff hash no longer matches |
| `needs-regenerate`  | catch-all for "something changed" |
| `missing`           | no checkpoint on disk yet — record one with `--record-checkpoint` or `--write-patch` |

The JSON form (`--json`) returns the full `checkpoint` + `checkpointStatus`
+ `checkpointReasons` so CI gates can fail on drift.

## MCP

`get_adoption_checkpoint_status` returns the same shape for either kind:

```jsonc
{ "kind": "onboard", "exists": true, "status": "stale-target", "reasons": ["…"], "changedTargets": ["sharkcraft/rules.ts"] }
```

Read-only — never writes a checkpoint.
