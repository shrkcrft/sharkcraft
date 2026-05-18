# `shrk check`

Local validation that orchestrates the existing inspector services into a
single pass. Designed for CI gates and pre-commit hooks.

```bash
shrk check                                        # full sweep
shrk check --strict                               # warnings fail
shrk check packs                                  # one group
shrk check pipelines
shrk check knowledge
shrk check templates
shrk check generation <templateId> <name> --var k=v ...
```

## Groups

| Group | What it checks |
|---|---|
| `doctor` | Runs the same checks as `shrk doctor`. |
| `knowledge` | Duplicate ids, missing required fields. |
| `templates` | Each template has id, description ≥ 5 chars, valid file resolver. |
| `pipelines` | Each pipeline has steps, no duplicate step ids, description present. |
| `packs` | Wraps `shrk packs doctor` (manifests, contributions, signatures, dups). |
| `action-hints` | Soft warnings only — critical/high workflow entries without hints. |

`generation` is a separate subcommand that validates a one-off generation:

```bash
shrk check generation typescript.service profile --var className=ProfileService
```

It runs the same dry-run path as `shrk gen` but does not write anything —
useful for "would this generation succeed in CI?"

## Exit codes

- `0` — every group passed.
- `1` — at least one group had errors, **or** `--strict` is set and any
  warnings exist.
- `2` — invalid CLI usage.

## CI example

```yaml
- run: bun install
- run: bun x shrk doctor --strict --min-score 70
- run: bun x shrk check --strict
- run: bun x shrk packs verify --required        # if you publish signed packs
```
