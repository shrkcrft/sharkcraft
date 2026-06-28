# Wiring checks (the completeness plane)

Boundary and architecture rules cover the **direction plane**: which imports a
file may *not* make. Wiring rules cover the complementary **completeness
plane**: a value or identifier that is *declared* in one place must also be
*registered* (wired up) somewhere else — otherwise the build is green but the
feature silently does nothing at runtime. The classic shape is **"declared but
not wired"**: an entry is added to one list, the matching registration in
another file is forgotten, `tsc` is happy, and the gap only surfaces when a
human exercises the feature.

`shrk check wiring` and the `wiring` quality gate close that gap with a
**generic, deterministic, data-defined** engine. There is no AI and no
language-specific knowledge — every rule is a cross-file set-membership check
you supply as data, so it works for any project, framework, or token shape.

## The model

A wiring rule collects two token sets and flags the difference:

- **declared** — tokens captured from one set of files (the "used" / "referenced" side).
- **registered** — tokens captured from another set of files (the "wired-up" side).

Every **declared** token that is **not** in the **registered** set is a
violation, reported at its first declaring `file:line`. (This is the same
extraction the boundary engine runs, but over captured string tokens instead of
import paths.)

## Configuring rules

Declare rules under `wiringRules[]` in `sharkcraft.config.ts`. Each side is a
set of globs plus a regex whose **capture group 1** is the token:

```ts
export default defineSharkCraftConfig({
  wiringRules: [
    {
      id: 'feature.flag-must-be-registered',
      description: 'Every referenced feature flag must be registered in the flag table.',
      severity: 'error', // 'error' (default) fails; 'warning' reports only
      declared: {
        files: ['src/**/*.ts'],
        pattern: "useFlag\\(['\"]([\\w.-]+)['\"]\\)", // group 1 = the flag name
      },
      registered: {
        files: ['src/flags/registry.ts'],
        pattern: "registerFlag\\(['\"]([\\w.-]+)['\"]\\)",
      },
      hint: 'Add a registerFlag(...) entry in src/flags/registry.ts.',
    },
  ],
});
```

Field reference:

| field | meaning |
|---|---|
| `id` | stable id, shown in findings and selectable with `--only` |
| `description` | one-line statement of the guarantee |
| `severity` | `error` (default, fails) or `warning` (reports, does not fail) |
| `declared.files` / `registered.files` | project-relative globs (`**`, `*`, `?`) |
| `declared.pattern` / `registered.pattern` | regex source; **capture group 1** is the token. `g` is always applied; add more via `flags` |
| `declared.flags` / `registered.flags` | extra regex flags (e.g. `i`, `m`) |
| `hint` | remediation line printed on each violation |

### Authoring patterns safely

- **Capture group 1 is required.** The token is `match[1]`; a pattern with no
  capture group captures nothing. This is rejected at config load with a clear
  error (and the engine degrades a stray bad rule to a diagnostic rather than a
  silent green).
- **Keep the group narrow** — `([\w.-]+)`, not `(.*)` — so the token set is
  precise.
- **Avoid catastrophic backtracking** (nested quantifiers like `(([a-z]+)+)$`):
  the pattern runs over file contents and a pathological regex can be slow on a
  runtime without a backtracking cap. Files larger than ~1 MB are skipped.
- An **uncompilable pattern or bad `flags`** is caught at config-load time
  (`shrk doctor` and the loader report the exact `wiringRules[n].<side>.pattern`
  location); it never crashes `shrk check wiring` or the `shrk gate` aggregator.

## Running it

```bash
shrk check wiring                 # all rules, full tree
shrk check wiring --changed-only  # only rules touched by the working-tree change set
shrk check wiring --since <ref>   # only rules touched by changes since <ref>
shrk check wiring --only id1,id2  # only the named rules
shrk check wiring --json          # machine-readable report (schema: sharkcraft.wiring/v1)
```

Exit code is `1` when any `error`-severity rule has a violation, `0`
otherwise. `--changed-only` makes it cheap and diff-aware for pre-commit hooks
and CI.

## In the quality gate

When `wiringRules[]` is present, the `wiring` gate runs as part of
`shrk gate` (and the `get_quality_gates` MCP tool). With no rules configured the
gate reports `skipped` — it is inert until a project opts in, and never produces
a spurious red.

## When to reach for a wiring rule

Any "two lists that must stay in sync across files" relationship that the
compiler can't see, e.g.:

- a referenced key set must be a subset of a registered key set;
- an exported member must be included in an aggregate/barrel collection;
- a declared contribution must appear in the consumer's accepted set.

If the relationship *is* an import edge, use boundary rules
([boundaries](./overview.md)) instead — wiring is for value/identifier sets.
