# Doctor suppressions (R29) and acknowledgements (R38)

R29 adds focused filters and a persistent suppression file so doctor's
warnings can be triaged instead of all-on-or-all-off. R38 layers a typed
**acknowledgement** workflow on top: an acknowledgement is a suppression
that REQUIRES a non-empty `reason` and an explicit expiry. The on-disk
format is the same `sharkcraft/doctor.suppressions.json`.

## R38 — acknowledgement subcommands

```
shrk doctor acknowledge [--id <stable-id>|--code <code>|--category <cat>] \
                        --reason "<text>" \
                        (--expires-in 7d|--expires-at <ISO>) \
                        [--allow-error]
shrk doctor acknowledgements list [--json]
shrk doctor acknowledgements check [--json]
```

The `acknowledge` command rejects:

- empty / whitespace-only reasons,
- reasons that start with `TODO`,
- missing expiry (one of `--expires-in` / `--expires-at` is required),
- expiries in the past.

`--expires-in` accepts `7d`, `48h`, `2w`, `30m` style durations.

## R38 — doctor flags

```
shrk doctor --hide-acknowledged
shrk doctor --fail-on-expired-acknowledgement
```

`--hide-acknowledged` filters using only entries with an explicit
expiry; bare suppressions stay visible. `--fail-on-expired-acknowledgement`
exits non-zero if any acknowledgement has expired.

The doctor JSON output now also includes an `acknowledgements` block
with `active / expiringSoon / expired / bareSuppressions` counts plus
the flag settings.

## R29 — original suppression surface (still supported)

## Flags

```
shrk doctor --focus errors,warnings-new,info,ok,all
shrk doctor --hide action-hint-quality,missing-commands-or-mcp,...
shrk doctor --quiet-known
```

- `--focus` limits the headline view to a severity subset.
  `warnings-new` means "warnings that have no matching suppression."
- `--hide <category>` drops a derived category from the view. Common
  categories: `action-hint-quality`, `missing-commands-or-mcp`,
  `pack-doctor`, `boundary`, `general`.
- `--quiet-known` also drops `ok` rows whose category matches a live
  suppression (cosmetic cleanup).

## Suppression management

```
shrk doctor suppress [--id <stable-id> | --code <code> | --category <cat>] --reason "<text>" [--expires-at YYYY-MM-DD] [--allow-error]
shrk doctor suppressions list
shrk doctor suppressions check
```

`--id` is preferred (stable per-finding identifier). `--code` matches
the underlying finding id (a code-class). `--category` matches the
derived category.

Reasons are required. Without a reason the suppression is rejected.
Errors are NOT suppressed unless `allowError: true` is set.

## File

`sharkcraft/doctor.suppressions.json` (schema:
`sharkcraft.doctor-suppressions/v1`):

```json
{
  "schema": "sharkcraft.doctor-suppressions/v1",
  "doctorSuppressions": [
    {
      "category": "action-hint-quality",
      "reason": "noisy legacy hints — re-evaluate after rules audit",
      "expiresAt": "2026-09-01"
    }
  ]
}
```

## Behaviour

- Suppressed findings are counted, not deleted. The summary shows both
  active and suppressed counts.
- Expired suppressions surface as a warning so authors notice.
- Default doctor behaviour (no flags, no suppressions file) is
  unchanged.

## MCP

- `get_doctor_suppressions({})`
- `get_doctor_filtered_report({ focus?, hide?, quietKnown? })`

Both read-only.
