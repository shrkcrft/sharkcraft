# Ingest adoption apply (R27) — removed

R26 introduced the ingest adoption *patch* — a reviewable diff under
`sharkcraft/ingestion/adoption/`. R27 added a signed apply path for it.

> **Removed.** The signed apply path (the former `ingest adopt plan`,
> `ingest adopt review` and `ingest adopt apply` subverbs) was removed: each
> now refuses with exit 2 and points at `shrk onboard adopt`, the canonical
> adoption surface. `shrk ingest adopt` itself still builds the reviewable
> adoption patch.

## Pipeline

```
shrk ingest repository           # build the knowledge model (dry-run)
shrk ingest adopt                # build the adoption patch (dry-run)
shrk onboard adopt               # adopt through the canonical surface
```

The apply plan reuses the existing `sharkcraft.plan/v1` shape so any
custom CI/Plan-review tool keeps working.

## Target allowlist

The apply path will refuse any change whose `relativePath` is not under
`sharkcraft/` or `sharkcraft/docs/tasks/`. Refused entries appear in
`built.skipped` with reason `"target outside sharkcraft/ — refused"`.

## Signing

`SHARKCRAFT_PLAN_SECRET` (HMAC-SHA256) signs a plan; the same secret is used
by `shrk gen --sign` and `shrk apply --verify-signature` — the signing
contract every plan/apply path still follows. The removed ingest apply path
used it too: without the secret a plan was unsigned and `apply
--verify-signature` refused it.

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
