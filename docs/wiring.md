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
| `<side>.arrayProperty` | capture array-literal elements of `<name> = [ … ]` / `<name>: [ … ]` instead of a regex (mutually exclusive with `pattern`) — see [Advanced matchers](#advanced-matchers) |
| `registered` (array) | a list of sources, unioned before the subset check |
| `groupBy` | `'dir'` / `'package'` — match within the same module, not the global pool |
| `mode` | `'subset'` (default) or `'parity'` (also report registered-but-not-declared) |
| `hint` / `hintDeclaredMissing` / `hintRegisteredMissing` | remediation line(s); the directional hints apply in `parity` mode |

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

## Advanced matchers

The simple `{ files, pattern }` shape covers a top-level-line registration. Four
optional primitives let you author the harder cross-file invariants as data —
no shrk-source change.

### Array-literal membership (`arrayProperty`)

When the registration target is an **array literal** (`things: [A, B, C]` or
`export const ARR = [A, B, C]`) rather than a one-token-per-line list, set
`arrayProperty` instead of `pattern`. It captures each element token (identifier
or quoted string) of every `<name> = [ … ]` / `<name>: [ … ]` literal — exactly
one of `pattern` / `arrayProperty` per side:

```ts
registered: { files: ['src/registry.ts'], arrayProperty: 'BLOCKS' }, // const BLOCKS = [A, B] OR blocks: [A, B]
```

### Union of N registered sets

`registered` accepts an **array of sources** that are unioned before the subset
check — a token is wired if **any** source has it. Use it when an id may be
registered in a record's keys *or* a per-item array *or* a flat allowlist:

```ts
registered: [
  { files: ['src/builtins.ts'], pattern: "^\\s*([A-Z_]+):" },
  { files: ['src/extra.ts'], arrayProperty: 'EXTRA' },
],
```

### Per-module scoping (`groupBy`)

By default declared/registered tokens are matched in one global pool. Set
`groupBy: 'dir'` (or `'package'`) so a token declared in module M must be
registered **within module M** — a same-named token in module N won't satisfy
it. This expresses "every field of a module's interface appears in that same
module's schema".

### Parity mode (`mode: 'parity'`)

The default `subset` mode reports only declared-but-not-registered. `parity`
also reports **registered-but-not-declared**, direction-aware: each violation
carries a `direction` (`declared-missing` / `registered-missing`) and you can
give a per-direction message via `hintDeclaredMissing` / `hintRegisteredMissing`
(e.g. "won't persist" vs "won't serialize").

A misconfigured rule (a side with neither `pattern` nor `arrayProperty`, a bad
regex, etc.) degrades to a diagnostic — never a silent green.

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

### Honest scope accounting under `--changed-only`

A scoped run **never renders a green over zero evaluated rules**. When the scope
selects nothing to run, it prints `0 rules evaluated — NOT verified` (loud), and
every run reports `rules evaluated M of N (K skipped by --changed-only)` where N
is the **total** configured rule count. The unqualified "every declared token is
registered ✓" prints **only when all N configured rules evaluated**; otherwise
you get the qualified "No wiring violations among the M evaluated rule(s) —
(N−M) NOT verified". The `--json` report carries `configured`, `selected`,
`evaluated`, `skippedByScope`, `matchedNothing`, and `notVerified`, so the
accounting is machine-checkable.

## Inspecting a rule before you commit it (`explain` / `test`)

Authoring a wiring rule is a tuning loop: a rule is only as good as the
alias-resolved set-difference it computes, and that set is invisible until you
run the gate. Two read-only commands surface it **without writing config**:

```bash
shrk wiring explain <ruleId>          # dry-run ONE configured rule
shrk wiring test <candidate.json>     # dry-run an EPHEMERAL candidate rule
shrk wiring test '{"id":"x","declared":{…},"registered":{…}}'   # inline JSON
```

Both print, with `file:line` at every site:

- the **declared set** the rule extracted,
- the **registered set** (union of all registered sources) it extracted,
- the **set-difference** (`declared but NOT registered`, plus `registered but
  NOT declared` in `parity` mode),
- the verdict and any misconfiguration diagnostics.

`explain` resolves the rule from `sharkcraft.config.ts`; `test` takes a
candidate rule as a `.json` file or inline JSON, so you can iterate on a
pattern against the live tree before committing it. `shrk check wiring --explain
<ruleId>` is the same view reachable from the gate. (Mirrors the
`search tuning explain` dry-run.)

## The registration / DI graph (`chain` / `unprovided` / `orphans`)

Wiring **rules** answer one fixed pass/fail question. The complementary
**registration graph** models the three roles a token plays so you can *query*
runtime wiring imports can't see:

- **declared** — where a token/provider is defined (an injection token, an
  `@Injectable` class, a capability definition);
- **provided** — where it is registered into a composition (a `providers: [...]`
  array, a kernel `register*()` call, a module import);
- **consumed** — where it is injected/used (`@Inject(X)`, a constructor param,
  an `inject(X)` call, a `useX()` hook).

You declare the idiom *shapes* as data — each role reuses the same `{ files,
pattern | arrayProperty }` extractor as a wiring rule — under
`registrationGraph[]` in `sharkcraft.config.ts` (a framework pack can contribute
them via the `registrationGraphFiles` slot, same as `wiringRules`):

```ts
export default {
  registrationGraph: [
    {
      name: 'di-providers',
      declared: { files: ['src/**/*.ts'], pattern: "export const (\\w+) = new InjectionToken" },
      provided: { files: ['src/**/*.ts'], arrayProperty: 'providers' },
      consumed: { files: ['src/**/*.ts'], pattern: "inject\\((\\w+)\\)" },
    },
  ],
};
```

Then query it:

```bash
shrk wiring chain <token>     # declared → provided → consumed, file:line per hop + verdict
shrk wiring unprovided        # tokens declared/injected but NEVER provided
shrk wiring orphans           # tokens provided but NOTHING consumes them

# Scope the verdict to a changeset (the tokens THIS change touched):
shrk wiring unprovided --changed-only     # vs the working tree
shrk wiring unprovided --base main        # vs a git ref
shrk wiring orphans --changed-only
```

- **`unprovided`** is the silent-at-runtime class: typecheck/AOT-green, but the
  provider is never registered (or the injected token has no provider anywhere),
  so it resolves to `undefined` at runtime. Exit `1` when any are found.
- **`orphans`** is a build-clean dead registration — a provider nothing injects,
  often a renamed/removed consumer. Advisory (exit `0`).
- **`chain`** is the full hop-by-hop trace for one token, tagged
  `wired` / `unprovided` / `orphan`.
- **`--changed-only` / `--base <ref>`** scope `unprovided` / `orphans` to tokens
  with a role-site in the changeset — the change-attributed "did *I* leave a
  token unprovided?" question a pre-commit gate wants. An **empty** changed scope
  evaluated nothing, so it exits `2` (NOT verified), never a green `0`; this is
  the gate that slots into `shrk finish` (see [exit-codes.md](exit-codes.md)).

This is the natural superset of the "is X registered" wiring rules: a real
registration graph turns the question from a hand-authored regex into a query
(schema `sharkcraft.registration-graph/v1`).

Agents can reach the same graph read-only over MCP via **`get_wiring_graph`**
(returns `unprovided` + `orphans`, plus a token's `chain` when `token` is
passed) — no shell-out, and it never writes the on-disk cache (the CLI owns
that). And `shrk finish` runs the `unprovided` query as a **diff-aware** gate:
besides a newly-injected token with no provider, it flags a token whose last
**provider you deleted** — the most common way DI wiring silently breaks, which
leaves no site in the changed file for post-change scoping to see.

The scan is **cached by the code-graph digest** (`.sharkcraft/cache/`), so
repeated session queries (`chain` + `unprovided` + `orphans`) reuse one scan; a
reindex rotates the digest and invalidates it. `chain`/`orphans` on a single
token are naturally cheap; `unprovided` is the repo-wide sweep.

**On-demand, by design.** The graph is built on demand from the idiom specs
rather than persisted as new edge kinds in the incremental-reindex hot path —
that keeps a noisy/wrong idiom spec contained (it can't pollute `impact` /
`callers`), and the queries don't need persistence. The spec's three roles
(`declared` / `provided` / `consumed`) and its site records (`{ idiom, file, line
}`) map one-to-one onto future `provides` / `registers` / `consumes` edges, so
persisting them later is a **storage change, not a redesign**.

## Tracing a raw string contract (`trace literal`)

When two sides of a fence deliberately **duplicate a string literal** (a kind
slug, a permission id, a route key) so the type system can't link them,
`shrk trace literal "<string>"` finds every occurrence of that exact literal,
**classified by direction** (declare → register → consume) and alias-resolved
(`const X = "lit"` bindings and their uses), across files and layers — the chain
grep can't give. See also [registry-inventory](./registry-inventory.md) for the
pre-declared-registry variant (`registry … where`).

## Extracting the tokens

Both sides use the shared **[extraction DSL](./extraction-dsl.md)** — nine
extractor kinds (`array-members`, `object-keys`, `enum-members`, `export-names`,
`call-args`, `decorator-args`, `string-union-members`, `json-path`,
`regex-capture`) plus `match` / `exclude` filters:

```ts
declared: {
  files: ['src/plugins/**/*.ts'],
  extract: 'export-names',
  match: '.*Plugin$',
  exclude: '^legacyPlugin$',   // a known exception, declared as data
},
registered: {
  files: ['src/registry.ts'],
  extract: 'array-members',
  anchor: 'PLUGINS',           // reads `export const PLUGINS = Object.freeze([ … ])` too
},
```

`pattern` (regex) and `arrayProperty` remain as sugar for `regex-capture` and
`array-members`.

## Relations

| Field | Values | Meaning |
|---|---|---|
| `mode` | `subset` (default) | every declared token must be registered |
| | `parity` | also flags a registered token that was never declared (an orphan sink) |
| | `disjoint` | no token may appear on **both** sides (an exclusion invariant) |
| `registeredMode` | `union` (default) | registered if **any** sink has it |
| | `intersection` | must appear in **every** sink — the explicit answer to "registered in the wrong one of N sinks" |

### Multi-hop (`chain`)

A "declared → registered → wired" seam is **one** rule, not three brittle ones.
`chain` takes an ordered list of ≥2 sources and evaluates `hop0 ⊆ hop1`,
`hop1 ⊆ hop2`, …; each violation names the hop that broke.

```ts
{
  id: 'declared-registered-wired',
  chain: [
    { files: ['src/**/*.ts'], extract: 'export-names', match: 'Handler$' },
    { files: ['src/registry.ts'], extract: 'array-members', anchor: 'HANDLERS' },
    { files: ['src/router.ts'], extract: 'object-keys', anchor: 'ROUTES' },
  ],
}
```

`chain` is mutually exclusive with `declared`/`registered`, and each hop is a
subset relation (`mode` must be `subset`).

## Messages, empty rules, self-tests

- **`message`** — the violation headline, with `{id}` / `{token}` / `{file}` /
  `{line}` / `{rule}` substitution.
- **`failOnEmpty`** — a rule whose *source* side matches 0 files or extracts 0
  ids is `skipped`, and the check returns `2` (not verified), never a green `0`.
  `failOnEmpty: true` promotes that to a real failure. An empty **sink** is
  different: it stays a failure, annotated as `emptySink` because it is nearly
  always a stale sink glob.
- **`selfTest`** — declare `expectMatchesAtLeast` / `expectIds` /
  `expectNotIds` and [`shrk gates coverage`](./gate-rules.md) tests the rule like
  code instead of trusting it like config.

## `--fix` — the mechanically-unambiguous case only

A `declared-but-not-registered` violation has a deterministic repair when there
is exactly one sink array: append the token to it. `--fix` does that, and
nothing else.

```bash
shrk check wiring --fix            # dry run: prints the exact edit, writes nothing
shrk check wiring --fix --write    # apply it
shrk check wiring --fix --json     # the planned edits, machine-readable
```

```
=== Wiring fix (dry run) ===
  would add BETA_HANDLER → src/registry.ts:3
      + BETA_HANDLER,

  Left untouched (1) — not mechanically unambiguous:
    • GAMMA_HANDLER  [ambiguous-sink] rule has 2 registered sinks — which one should the token join?

Dry run — nothing written. Re-run with `--write` to apply.
```

**It refuses far more than it fixes, on purpose.** A wrong autofix in a gate is
worse than no autofix — the tool would be writing the very thing it is supposed
to verify. An edit is planned ONLY when all of these hold:

| Requirement | Refusal code when it doesn't |
|---|---|
| exactly one registered sink (never a `chain` rule) | `ambiguous-sink` |
| that sink is an `array-members` source | `sink-not-an-array` |
| its glob resolves to exactly one file | `ambiguous-sink-file` |
| the anchor array appears exactly once in it | `array-not-found` |

Everything else is listed with its reason and left alone — a gate that silently
half-fixes is worse than one that does nothing, because you cannot see what it
skipped. `parity` (`registered-missing`) violations are never auto-fixed: the
repair there is a deletion or a new declaration, and neither is mechanical.

The planner matches the code already in the array — bare identifiers vs quoted
strings, single vs multi-line, existing trailing-comma style — and preserves the
whitespace before the closing bracket, so it never reformats code you did not
ask it to touch.

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
