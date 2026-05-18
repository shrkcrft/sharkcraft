# ESLint bridge

SharkCraft does not aim to replace ESLint. The bridge lets teams that
already standardize on ESLint **integrate** SharkCraft findings into
their existing flow without giving up the SharkCraft CLI / CI.

## Surface (R45 + R47)

```bash
shrk eslint scaffold                # emit a flat-config snippet
shrk eslint config --preset auto    # alias of scaffold (preferred name in feature_47.md)
shrk eslint report --from boundaries.json   # convert boundary JSON to ESLint result format
shrk eslint rules [--filter <bucket>]       # inventory of what bridges
shrk eslint explain-limitations             # what does NOT bridge
```

## `scaffold` (R45)

Emits an `eslint.sharkcraft.config.mjs` flat-config snippet that:

- ignores SharkCraft-tracked generated paths,
- documents which SharkCraft path conventions exist,
- references `shrk check boundaries` as the canonical cross-layer
  enforcement.

Default dry-run; `--write` persists. `--preset auto` triggers
detection-driven choices (today: no behaviour difference, reserved
for future detection hooks).

## `report` (R45)

Takes `shrk check boundaries --json` output and re-emits it as an
ESLint result-format array. ESLint-aware tooling (reviewdog, GitHub
annotations, the IDE ESLint plugin) can then surface SharkCraft
boundary violations as if they were ESLint findings.

```bash
shrk check boundaries --json > boundaries.json
shrk eslint report --from boundaries.json > eslint-results.json
# Now anything that ingests an ESLint result file sees SharkCraft data.
```

Exit code is 1 when violations are present, 0 when empty.

## `rules` (R47)

Reads the live SharkCraft rules + path conventions and classifies
each as:

- **bridgeable** — representable via `no-restricted-imports`,
  `@typescript-eslint` naming, or filename plugins.
- **adjacent** — surfaced through `shrk eslint report` (ESLint result
  format) but not as a native ESLint rule.
- **not-bridgeable** — only the SharkCraft CLI / CI gate enforces.
  Plan signing, pack signatures, knowledge stale-check, template
  drift, self-config doctor.

Filter with `--filter bridgeable|adjacent|not-bridgeable`. The `--json`
mode emits a stable machine shape for tooling that wants to scaffold
custom rules.

## `explain-limitations` (R47)

Prints the honest list:

| What ESLint can do | What ESLint cannot do |
|---|---|
| `no-restricted-imports` for forbidden imports / layer boundaries | Plan safety (`--verify-signature`) |
| Generated path ignores | Pack signatures |
| `@typescript-eslint` naming / file-shape rules | Knowledge stale-check |
| Surface SharkCraft findings via the result format | Template drift |
| | Self-config doctor |
| | Safety audit (`--deep`) |

The recommendation: keep `shrk doctor`, `shrk check boundaries`,
`shrk safety audit`, and (if you ship packs) `shrk packs doctor` in
CI. Use ESLint for source-file linting only.

## Integration patterns

### Pattern 1 — ESLint stays canonical for source linting

```yaml
- run: bun run shrk check boundaries --json > boundaries.json
- run: bun run shrk eslint report --from boundaries.json > sharkcraft-as-eslint.json
- run: npx eslint . --output-file native-eslint.json --format json
- run: bun run shrk checks import sharkcraft-as-eslint.json --as eslint
- run: bun run shrk checks import native-eslint.json --as eslint
- run: bun run shrk checks aggregate
```

Both ESLint and SharkCraft findings flow into the same v1 rollup.

### Pattern 2 — Reviewdog-style PR annotations

```yaml
- run: shrk check boundaries --json > boundaries.json
- run: shrk eslint report --from boundaries.json > eslint.json
- uses: reviewdog/action-eslint@v1
  with:
    eslint-flags: '--format compact'
    # Point reviewdog at eslint.json — it sees SharkCraft violations.
```

### Pattern 3 — IDE annotations

Open `eslint.json` in any IDE with ESLint integration; SharkCraft
boundary violations show up as red squigglies. No SharkCraft-specific
IDE plugin required.

## Why not just write a `@shrkcrft/eslint-plugin`?

Considered and deferred to a later round.

- ESLint's rule lifecycle is fixed-point: it expects a function over a
  source AST. SharkCraft's boundary / plan-signing / pack-signature
  rules are workspace-level and need access to `inspectSharkcraft()`,
  the pack registry, signing material, and the cross-package import
  graph. Trying to fit that into ESLint's per-file lifecycle would
  duplicate the SharkCraft engine inside an ESLint plugin.
- The R47 bridge is the pragmatic alternative: emit ESLint-shaped JSON
  *outside* of ESLint, then let the existing ESLint tooling consume
  it. No engine duplication. No drift.

If shipping a plugin still makes sense later, the entry point is the
`shrk eslint rules --json` inventory — a plugin would have to cover
the bridgeable bucket and explicitly document the adjacent / not-
bridgeable ones, exactly as R47 already does.
