# Ingest adoption apply (R27)

R26 introduced the ingest adoption *patch* — a reviewable diff under
`sharkcraft/ingestion/adoption/`. R27 adds a signed apply path so the patch
can be materialised through the same plan/apply pipeline used by
`shrk gen`.

## Pipeline

```
shrk ingest repository           # build the knowledge model (dry-run)
shrk ingest adopt                # build the adoption patch (dry-run)
shrk ingest adopt plan           # build the signed apply plan
shrk ingest adopt review <plan>  # render the plan as markdown (read-only)
shrk ingest adopt apply <plan> --verify-signature
```

The apply plan reuses the existing `sharkcraft.plan/v1` shape so any
custom CI/Plan-review tool keeps working.

## Target allowlist

The apply path will refuse any change whose `relativePath` is not under
`sharkcraft/` or `sharkcraft/docs/tasks/`. Refused entries appear in
`built.skipped` with reason `"target outside sharkcraft/ — refused"`.

## Signing

`SHARKCRAFT_PLAN_SECRET` (HMAC-SHA256) signs the plan; same secret is used
by `shrk gen --sign` and `shrk apply --verify-signature`.

```bash
export SHARKCRAFT_PLAN_SECRET=$(openssl rand -hex 32)
shrk ingest adopt plan --output /tmp/ingest.plan.json
shrk ingest adopt review /tmp/ingest.plan.json
shrk ingest adopt apply /tmp/ingest.plan.json --verify-signature
```

Without `SHARKCRAFT_PLAN_SECRET` the plan is unsigned and `apply
--verify-signature` refuses; without `--verify-signature` an unsigned plan
applies (matching the existing `shrk apply` policy).

## Previewing read-only

The standalone `preview_ingest_adoption_plan` MCP tool was retired. To
preview without persisting, run the ingest planner in dry-run on the CLI
(`shrk ingest … --dry-run`): it returns the plan body (including
byte-counted `expectedChanges`) and writes nothing. Applying the plan is
always the human-run CLI step (`shrk apply`), never an MCP write.

## Schema

The plan is `sharkcraft.plan/v1` — fully compatible with the existing
`shrk apply` engine. Each expected change has `type: 'append' | 'create'`,
a relative path under `sharkcraft/**`, byte count, and (optionally) an
HMAC signature block.
