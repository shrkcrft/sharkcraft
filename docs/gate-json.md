# The gate JSON envelope (`sharkcraft.gate/v1`)

Every gate verb has always supported `--json`, but each plane emitted its own
schema — `sharkcraft.wiring/v1`, `sharkcraft.policy-lint/v1`,
`sharkcraft.baseline/v1`, `sharkcraft.generated-drift/v1`,
`sharkcraft.gate-coverage/v1`. A CI step or an agent that wanted one answer
("which rules ran, which failed, and why?") had to parse five shapes.

Every gate verb now also emits a **shared envelope** under a `gate` key:

```bash
shrk check wiring     --json | jq .gate
shrk policy-lint      --json | jq .gate
shrk baseline check   --json | jq .gate
shrk generated check  --json | jq .gate
shrk gates coverage   --json | jq .gate
```

```jsonc
{
  "schema": "sharkcraft.gate/v1",
  "verb": "check wiring",
  "exit": 1,                     // the code the process actually returns
  "evaluated": 1,
  "skipped": 1,
  "failed": 1,
  "rules": [
    {
      "id": "handlers-registered",
      "type": "wiring",          // wiring | policy | registry | registration | baseline | generated
      "status": "failed",        // passed | failed | skipped | error
      "severity": "error",
      "counts": { "declared": 90, "registered": 89 },
      "violations": [
        { "id": "NEW_HANDLER", "file": "src/handlers/new.ts", "line": 2, "hint": "Add it to HANDLERS." }
      ]
    },
    {
      "id": "stale-rule",
      "type": "wiring",
      "status": "skipped",
      "severity": "error",
      "counts": { "declared": 0, "registered": 89 },
      "violations": [],
      "skipReason": "0 files matched the source globs"
    }
  ]
}
```

## It is additive, on purpose

The per-plane payloads are published, documented, and asserted by tests.
Replacing them would break every existing consumer, so the envelope rides
**alongside** them:

```jsonc
{
  "schema": "sharkcraft.wiring/v1",   // unchanged
  "rules": [ { "ruleId": "…" } ],     // unchanged, plane-specific shape
  "gate":  { "schema": "sharkcraft.gate/v1", … }   // new, identical across planes
}
```

`jq .gate` is the uniform read; everything that worked before still works.

## Field notes

| Field | Meaning |
|---|---|
| `exit` | The code the process returns — always consistent with the [exit-code contract](exit-codes.md). Read this instead of re-deriving a verdict from the rule list. |
| `status` | `skipped` is first-class, never folded into `passed`. A rule that matched nothing enforced nothing. |
| `counts` | Plane-appropriate match counts (`declared`/`registered`, `committed`/`current`, `units`/`findings`, …). Always present, so "what did this rule see?" is answerable uniformly. |
| `skipReason` | Present exactly when `status` is `skipped` — the sentence explaining what matched nothing. |
| `error` | Present when the rule is misconfigured (`status: "error"`). |

## A CI step that works for any plane

```bash
for verb in "check wiring" "policy-lint" "baseline check" "generated check"; do
  shrk $verb --json | jq -e '
    .gate as $g
    | if $g.failed > 0 then
        ($g.rules[] | select(.status=="failed" or .status=="error")
         | "FAIL \(.type)/\(.id): \(.violations | length) violation(s)"), false
      elif $g.skipped > 0 then
        ($g.rules[] | select(.status=="skipped")
         | "STALE \(.type)/\(.id): \(.skipReason)"), false
      else true end'
done
```

See also [`shrk gates coverage`](gate-rules.md), which answers the same question
across every plane in one command.
