# Custom checks

Some rules cannot be enforced by the import-graph boundary engine —
"do not create files whose body is purely re-exports" is a body-shape
check, not a layer rule. R43 added a small **custom-checks** model so
rules can carry deterministic external checks without dragging a full
codemod / AST framework into the engine.

## Descriptor model

Custom-check metadata lives on the rule entry under
`metadata.checks: ICustomCheckDescriptor[]`:

```typescript
metadata: {
  checks: [
    {
      id: 'architecture-no-reexport-proxy',          // unique
      ownerRuleId: 'architecture.no-reexport-proxy', // filled by engine
      command: 'bun run scripts/check-no-reexport-proxy.ts',
      kind: 'text-shape',                             // import-graph | ast-shape | text-shape | project-script | external-tool
      safety: 'read-only',                            // read-only | writes-report | writes-preview
      output: 'json',                                 // json | text | exit-code
      reportPath: '.sharkcraft/reports/no-reexport-proxy.json',
      scope: 'all',                                   // changed-only | staged | all
      description: 'Find files whose body is purely re-export statements.',
      tags: ['imports', 'cleanup'],
    },
  ],
}
```

The engine never invents a check; it only inventories what authors
declare on rules.

## CLI

```bash
shrk checks list                        # list all declared checks (read-only)
shrk checks list --rule <ruleId>        # filter by owner rule
shrk checks doctor                      # validate descriptors (id pattern, dup ids, missing reportPath when output=json)
shrk checks run <checkId>               # report-only by default — does NOT spawn
shrk checks run <checkId> --execute     # actually invoke the command
shrk checks parse-report <path>         # ingest + validate a sharkcraft.custom-check/v1 file
```

`shrk checks list` and `shrk checks doctor` are read-only and never
spawn a process. Even `shrk checks run` does nothing unless you pass
`--execute`. This keeps the engine's safety contract intact — running
the script is the user's choice.

## Report convention: `sharkcraft.custom-check/v1`

Project scripts are **encouraged** to emit JSON in this shape:

```json
{
  "schema": "sharkcraft.custom-check/v1",
  "checkId": "architecture-no-reexport-proxy",
  "ruleId": "architecture.no-reexport-proxy",
  "generatedAt": "2026-05-16T00:00:00.000Z",
  "status": "pass | warn | fail",
  "findings": [
    {
      "severity": "error | warning | info",
      "file": "libs/foo/src/index.ts",
      "message": "file body is purely re-exports",
      "suggestedAction": "delete and re-route consumers",
      "safeToAutoFix": false
    }
  ],
  "metadata": { "totalProxyCount": 251 }
}
```

`shrk checks parse-report` validates the shape, and the codemod-assist
surface (`shrk codemod plan --from-report …`) reads the same file.

### Fallback formats

If the script cannot emit JSON immediately, the engine accepts:

- **Text output** — every non-empty line of the report becomes a
  `severity: warning` finding; status defaults to `warn`.
- **Exit-code only** — `shrk checks run --execute` reports the exit
  code; downstream tools key on it.

JSON is the preferred convention because it carries `file` /
`severity` / `suggestedAction` so the codemod-assist plan can group by
risk and emit a meaningful checklist.

## Hard rules

- The engine never spawns the script unless `--execute` is passed.
- `shrk checks` makes no MCP write tools available.
- `safety: writes-preview` and `writes-report` are *advisory*: the
  engine does not police what the script does. Keep the script
  honest.
- Duplicate check ids across rules are an error in
  `shrk checks doctor`.

## See also

- `docs/rule-authoring.md` — how to attach the descriptor to a rule.
- `docs/codemod-assist.md` — how to plan a cleanup from a check report.
