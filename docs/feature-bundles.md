# Feature workflow bundles

A **feature workflow bundle** groups everything that goes into shipping one
feature: multiple generation plans, plan dependency ordering, validation runs,
and a final report. Bundles live under `.sharkcraft/bundles/<id>/` and are
managed by the `shrk bundle` command surface.

Bundles never write source code themselves — only generation plans (under
`plans/`) and reports (under `reports/`). Applying remains a manual,
human-approved `shrk apply` invocation.

## CLI

```bash
shrk bundle create "<task>"           # creates .sharkcraft/bundles/<id>/
shrk bundle list                      # all bundles in this workspace
shrk bundle show <id>                 # full bundle metadata
shrk bundle status <id>               # one-word status
shrk bundle plan <id> --all-suggested # generate suggested plans
shrk bundle plan <id> --template <t> --name <n> --var k=v
shrk bundle graph <id> --format mermaid
shrk bundle apply-assist <id>         # ordered command list (does not apply)
shrk bundle apply-assist <id> --write-script
shrk bundle validate <id> --boundaries --report
shrk bundle decompose <id>            # deterministic task decomposition
shrk bundle report <id>
shrk bundle commands <id>
```

## Data model

`IFeatureWorkflowBundle` (schema `sharkcraft.feature-bundle/v1`) contains:

- `id`, `task`, `createdAt`, `updatedAt`, `projectRoot`
- `sessionId?`, `pipelineId?`
- `status` — `draft | planned | partially-applied | applied | validated | failed | completed`
- `plans[]`, `planGroups[]`, `dependencies[]`
- `validations[]`, `reports[]`
- `affectedFiles[]`, `affectedAreas[]`, `riskLevel`, `nextAction`, `commandHints[]`, `warnings[]`

## On-disk layout

```
.sharkcraft/bundles/<id>/
  bundle.json
  task.md
  task-packet.json
  decomposition.json
  commands.sh
  plans/
    <template>.json
    <template>.intent.md         # when required variables are missing
  reviews/
  reports/
    bundle-report.md
    validate-*.json
    apply-assist.sh              # only if --write-script was used
```

## MCP

Two read-only tools expose bundles:

- `list_feature_bundles`
- `get_feature_bundle`

Both return compact JSON. MCP never writes — creating or modifying bundles
remains a CLI-only operation.
