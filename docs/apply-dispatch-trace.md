# Apply dispatch trace (R38)

The trace explains which dispatch path `shrk apply` (or `shrk plan
review`) will take for a saved plan — without executing the apply.

## When to use it

- "Why is this plan being treated as synthetic?"
- "Which gates does the apply currently fail at?"
- "What flag combination unblocks this plan?"
- "How many file / folder operations does this plan actually carry?"

## CLI surfaces

```bash
shrk apply <plan> --trace                    # apply normally + print the trace
shrk apply <plan> --explain-dispatch         # print the trace, exit 0, do nothing
shrk plan review <plan> --trace-dispatch     # add trace to plan review output
```

`--json` includes the trace under `dispatchTrace`.

## What the trace describes

```
dispatchKind:         template | helper | plugin-lifecycle | registration-hint | synthetic | unknown
source:               registry/template | registry/helper | registry/plugin-lifecycle-profile | registry/registration-hint | synthetic | unknown
handler:              module + symbol that will run
synthetic:            templateId starts with `__`
totalFileOps:         number of file changes carried by the plan
totalFolderOps:       number of folder operations
fileOpCounts:         per-FileChangeType counts
folderOpCounts:       renameFolder + deleteFolder counts
plannedOperationKinds: distinct IPlannedOperation.kind values
signatureStatus:      not-checked | verified | unsigned | invalid
safetyGates[]:        signature, divergence, folder-ops-allow-flag,
                      folder-ops-safety, delete-folder-allow-flag,
                      contract-gate — each tagged
                      not-checked | will-pass | will-block | requires-flag
requiredFlags[]:      flags the operator must add for apply to succeed
finalAction:          dry-run | blocked | would-apply
blockReasons[]:       when blocked, the reason(s)
```

## Example

```
$ shrk apply /tmp/r38-trace.json --explain-dispatch
=== Apply dispatch trace ===
  schema           sharkcraft.apply-dispatch-trace/v1
  templateId       engine.cli-command
  dispatchKind     template
  source           registry/template
  handler          @shrkcrft/templates + @shrkcrft/generator/generator-engine.generate
  fileOps          0
  folderOps        0
  signature        not-checked
  finalAction      would-apply
  safety gates:
    signature                    not-checked
    divergence                   will-pass
```

## Schema

`sharkcraft.apply-dispatch-trace/v1`. The full TypeScript interface
lives at `packages/inspector/src/apply-dispatch-trace.ts`.

The trace is **read-only**; secrets are never emitted (only the
signature *status* is reported, not the signature payload).
