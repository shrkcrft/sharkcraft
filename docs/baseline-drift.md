# Baseline / ledger drift (`shrk baseline`)

Projects accumulate hand-rolled trios: a **committed baseline file**, a **script
that recomputes it**, and a **bespoke test that fails on drift** — one per
adoption ledger, API digest, coverage ratchet, allow-list or byte-pin. The
pattern is identical every time; only the *compute* and the *baseline file*
differ. Each re-implementation re-invents the update flow, and each one tends to
be **one-directional**: it catches additions and misses deletions.

`shrk baseline` is one engine for all of them. Every ledger gets the same
two-way semantics, the same explicit bless step, the same human-readable diff,
the same CI wiring, and the same [loud-on-empty safety](gate-rules.md#the-loud-skip-contract).

```bash
shrk baseline list                  # every declared baseline
shrk baseline check [--id X]        # recompute + diff vs committed → 0 / 1 / 2
shrk baseline diff  [--id X]        # +added / −removed, no verdict (inspection)
shrk baseline update [--id X]       # rewrite the committed artifact — the bless step
shrk baseline explain --id X        # what it computes, without judging it
```

## Configuring

```ts
export default defineSharkCraftConfig({
  baselines: [
    {
      id: 'public-api-surface',
      description: 'Every exported symbol of the public packages.',
      baseline: 'baselines/public-api.json',   // the committed artifact
      compute: {
        kind: 'command',                        // 'command' | 'extractor'
        run: 'node scripts/list-exports.mjs',   // stdout is the current value
        canonical: 'json-sorted-keys',          // applied to BOTH sides
      },
      direction: 'two-way',                     // 'two-way' | 'additions-only' | 'no-shrink'
      keyBy: 'symbols[*].name',                 // compare as a keyed SET (optional)
      watchFiles: ['packages/*/src/**/*.ts'],   // scope for --changed-only
      failOnEmpty: true,
      hint: 'Bless with `shrk baseline update --id public-api-surface`.',
    },
  ],
});
```

### `compute` — two kinds

| `kind` | Runs | Use when |
|---|---|---|
| `extractor` | a pure filesystem harvest via the [extraction DSL](extraction-dsl.md) | the value is "the set of ids in these files" — no shell, no side effects |
| `command` | a shell command; its **stdout** is the current value | the value needs a real tool (a bundler, a typechecker, a coverage run) |

An `extractor` baseline emits a pretty-printed JSON array of sorted, unique ids:
valid JSON *and* one id per line, so `git diff` shows exactly what moved.

> **Trust boundary.** A `command` compute spawns a shell, so it is honoured only
> from the repo's **own** `sharkcraft.config.ts`. The pack-plane merge seam
> **drops** any pack-contributed baseline that declares a `run`, with a
> diagnostic — mirroring the existing "pack-contributed verification commands are
> NOT auto-run" contract. Pack-shipped `extractor` baselines merge normally.

### `direction` — which way drift fails

| Value | Fails on |
|---|---|
| `two-way` (default) | gained **or** lost entries |
| `additions-only` | gained entries only |
| `no-shrink` | lost entries only (a ratchet) |

`two-way` is the default on purpose. A one-directional ledger is exactly how a
silent deletion ships; narrowing must be a visible, explicit choice.

### `canonical` — so a reformat is not drift

Both sides are canonicalized before comparison, so key order or re-indentation
never reads as a change. A noisy diff trains reviewers to bless without reading,
which is how a real deletion hides inside a "formatting" update.

| Form | Effect |
|---|---|
| `auto` (default) | `json-sorted-keys` when **both** sides parse as JSON, `lines` otherwise — a pure function of the two inputs |
| `json-sorted-keys` | parse, sort object keys recursively, re-serialize |
| `lines-sorted` | trim, drop blanks, sort |
| `lines` | trim, drop trailing blanks; order-sensitive |
| `raw` | byte comparison (only the trailing newline normalized) |

### How the diff names entries

| Mode | When | Reports |
|---|---|---|
| `keyed-set` | `keyBy` is set | per-key added/removed via a JSON path |
| `element-set` | both sides are a JSON array of scalars | per-element added/removed |
| `canonical-text` | otherwise | the line-level set difference |

### When the recompute yields nothing

Two different situations, kept distinct on purpose:

| Committed | Recomputed | Result |
|---|---|---|
| 0 entries | 0 entries | **skipped** — nothing was compared (exit `2`); `failOnEmpty` makes it a failure |
| N entries | 0 entries | **drift** — every entry is reported removed, annotated `emptyCompute` ("check the compute before blessing this") |

Collapsing the second case into a skip is how a broken compute quietly masks a
total wipe.

## `check` vs `update`

`update` is a **separate, explicit verb** — a drift can never be blessed as a
side effect of running the gate. It refuses to write an empty baseline for a
`failOnEmpty` rule (fix the compute first), and `--dry-run` reports what it would
write.

## `--changed-only`, honestly

`--changed-only` recomputes only the rules whose `watchFiles` (or, for an
extractor, whose `source.files`) intersect the diff. A `command` baseline with no
`watchFiles` **cannot** be scoped, so it is reported as `skipped` — never
quietly passed.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Every selected baseline was compared and matches. |
| `1` | Drift in the failing direction, a failed compute, or a missing committed artifact. |
| `2` | Nothing was compared — every rule was skipped, or none are declared. |

## Worked example (this repo)

```ts
baselines: [{
  id: 'mcp-tool-surface',
  baseline: 'baselines/mcp-tools.json',
  compute: {
    kind: 'extractor',
    source: {
      files: ['packages/mcp-server/src/tools/all-tools.ts'],
      extract: 'array-members',
      anchor: 'ALL_TOOLS',
    },
  },
  direction: 'two-way',
  failOnEmpty: true,
}]
```

Remove one tool from `ALL_TOOLS` and the gate says exactly what vanished:

```
✗ mcp-tool-surface  DRIFT — 0 added, 1 removed (283 committed → 282 now, element-set)
    - checkBoundariesTool
    → If the change is intentional, bless it with `shrk baseline update --id mcp-tool-surface`.
```
