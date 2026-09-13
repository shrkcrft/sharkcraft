# Boundary rules

A boundary rule declares which imports are forbidden — or, with an
`allowedImports` whitelist, which imports are permitted — for a set of
files. SharkCraft scans your project, evaluates every rule, and reports
violations.

## Minimum example

```ts
import { defineBoundaryRule } from '@shrkcrft/boundaries';

export default [
  defineBoundaryRule({
    id: 'core.no-ui-imports',
    title: 'core must not import UI',
    severity: 'error',
    from: ['src/core/**'],
    forbiddenImports: ['@scope/ui-*'],
    message: 'Core libraries must stay UI-free.',
    suggestedFix: 'Move shared contracts into core or invert the dependency.',
  }),
];
```

Ship it as `sharkcraft/boundaries.ts` **and list it** in
`sharkcraft.config.ts`:

```ts
export default { boundaryFiles: ['boundaries.ts'] };
```

A `sharkcraft/boundaries.ts` that is not listed loads NOTHING — `check
boundaries` then says so (`… exists but is not listed in boundaryFiles`) and
exits `2`; it is never auto-loaded, because that would start enforcing rules
nobody opted into. A pack contributes rules via its manifest's
`boundaryFiles: ['./src/assets/boundaries.ts']`.

Local rule files are loaded from SOURCE on every run (transpiled on the fly),
so a rule edit takes effect on the very next `check boundaries` — there is no
build step to forget. Only pack-contributed rule files can be stale (see
`shrk packs doctor`).

## Rule fields

| Field | Meaning |
|---|---|
| `id`, `title` | required |
| `severity` | `error` (the default when unset) · `warning` · `info` |
| `from` | file globs the rule governs; an entry starting with `!` is an exemption (see below); a bare `!`, a `!!x` or an only-`!` list is a validation error |
| `forbiddenImports` | specifier patterns forbidden from `from` files (package semantics — below); an empty, a `!`-prefixed or (under package semantics) a trailing-`/` pattern is a validation error |
| `forbiddenMatch` | `package` (default) · `exact` (entrypoint only) |
| `allowedImports` | when set, any external import matching none of these is a violation (exact globs, never widened; checked AFTER `forbiddenImports`, so it never re-admits a forbidden import) |
| `exemptFiles` | file globs subtracted from `from` — scanned, violations SUPPRESSED (marked, counted); plain globs only — a `!` here is a validation error |
| `excludeTests` | shorthand: exempt `**/__tests__/**`, `**/__mocks__/**`, `**/*.spec.*`, `**/*.test.*` |
| `exceptions` | `[{ path, target, reason }]` — adjudicated (path, target) pairs, `target` with the rule's forbidden-pattern semantics; a stale one FAILS the run |
| `failOnEmpty` | a rule whose `from` matches no file fails (`1`) instead of skipping (`2`); default on for `error` rules |
| `message`, `suggestedFix`, `tags`, … | reporting |

An invalid rule (no title, an unknown `forbiddenMatch`, an exception without a
reason, a specifier pattern that cannot mean what it says — see pattern
semantics below — …) is not dropped silently: it is an **errored rule** on every
surface — `ERROR <file>: rule '<id>' failed validation (…) — NOT evaluated` —
and the run exits `1`. So is a rule file that throws on import, exports no
rule array, or is listed but missing.

## Pattern semantics

The glob matcher is small and strict:

| Token | Matches |
|---|---|
| `**` | zero or more path segments (crosses `/`) |
| `*` | any characters EXCEPT `/` |
| `?` | one character except `/` |
| anything else | itself |

`from`, `exemptFiles` and `exceptions[].path` are matched against the
project-relative file path with exactly these rules.

**`forbiddenImports` (and `exceptions[].target`) use package semantics**
(round 11). Because `*` never crosses `/`, a bare pattern used to match only
the package entrypoint — `@scope/pkg` did not catch `@scope/pkg/sub`, and
`@scope/pkg-*` did not catch `@scope/pkg-b/deep/thing`: every subpath import of
the very package the rule forbids escaped the fence. Now:

| Pattern | `forbiddenMatch: 'package'` (default) | `forbiddenMatch: 'exact'` |
|---|---|---|
| `lodash` | `lodash`, `lodash/fp`, `lodash/get` — never `lodash-es` | `lodash` only |
| `@scope/pkg-*` | `@scope/pkg-a`, `@scope/pkg-b/deep/thing` | `@scope/pkg-a` only |
| `@scope/*` | `@scope/x`, `@scope/x/internal` | `@scope/x` only |
| `packages/ui` (a directory) | every alias-resolved path under `packages/ui/` | `packages/ui` only |
| `@scope/pkg/**` | `@scope/pkg/<anything>` — a `**` pattern says how deep it reaches, and is matched as written | same |
| `pkg/` (trailing slash) | **rejected** (an errored rule): it would match only an import written with that slash (`buffer/`), never `pkg` or its subpaths — write `pkg` (covers `pkg/` too) or `pkg/**` | the literal `pkg/` specifier (the userland-polyfill idiom) |
| `!pkg/internal/**` | **rejected** in every specifier list: negation is `from`-only syntax — carve-outs are `exceptions[]` | same |

The rule: a pattern with no `**` and no trailing `/` is a PACKAGE pattern — it
matches the specifier and everything under it (`<pattern>/**`), at a segment
boundary. A subpath hit is labelled on the violation (`matchKind: 'subpath'`,
text `matched forbidden package: <p> (subpath import — …)`), so a newly
reported edge explains itself.

A specifier pattern that cannot mean what it says is rejected when the rule
loads — an errored rule on every surface, local and pack rule files alike
(round 12): an empty pattern, a `!`-prefixed one, and — under package
semantics — a trailing `/`. Each used to load and match nothing its author
meant: `forbiddenImports: ['@scope/pkg/']` printed `Verdict: OK ✓` over imports
of `@scope/pkg`. `forbiddenMatch: 'exact'` (and `allowedImports`, always exact)
keeps a trailing-slash literal. A webpack inline-loader specifier really starts
with `!`: reach it by replacing the specifier's leading `!` with `?` (`?` is one
character, not a negation) — `?raw-loader!**` for `!raw-loader!./x.txt`, and
`?!raw-loader!**` for the double-bang `!!raw-loader!./x.txt`. `?!raw-loader!**`
never matches the single-bang form; a `?`-led pattern that matches no import
anywhere is reported as a dead unit like any other forbidden pattern.

`forbiddenMatch: 'exact'` is the opt-out for barrel-avoidance rules ("forbid
`lodash`, allow `lodash/get`").

**`allowedImports` is never widened**: allowing `react-dom` still flags
`react-dom/client`. Widening an allow-list is the permissive direction — it
would silently turn existing red into green — so a bare allowed pattern fails
loud, the safe direction. Write `react-dom/**` too if you mean it.

**Forbidden is checked first; `allowedImports` never re-admits.** An import a
forbidden pattern matches is a violation whatever the allow-list says, so an
`allowedImports` entry a forbidden pattern covers can never admit anything —
under package semantics a bare forbidden package covers every allowed subpath
of it (`forbiddenImports: ['@scope/pkg']` + `allowedImports:
['@scope/pkg/public/**']`). It is reported as a dead unit (`shadowed by
forbidden '@scope/pkg' — …`, `--json` `cause: 'shadowed'` and coverage
`allowed[].shadowedBy`). Carve the subpath out with `exceptions[{ path, target:
'@scope/pkg/public/**', reason }]`, or set `forbiddenMatch: 'exact'`.

**A pattern a sibling already covers is reported redundant** — `@scope/pkg/**`
next to `@scope/pkg` under package semantics (the `pkg` + `pkg/**` helper a
bare pattern used to need). `shrk boundaries explain <ruleId>` prints
`redundant '<p>' is covered by '<q>' … safe to delete`, `check boundaries`
prints one `note:` line, and `--json` coverage carries `forbidden[].subsumedBy`.
It is INFO only: never a dead unit, never a verdict change, and
`--fail-on-dead-units` ignores it.

> **Upgrading.** New violations labelled `subpath` after upgrading are REAL
> imports of a package your rule already forbids — the default is strictly
> stricter (`forbiddenMatch: 'exact'` restores entrypoint-only). An
> `allowedImports` entry under a bare forbidden package no longer carves
> anything out: it is reported as a shadowed dead unit (move it to
> `exceptions[]`). A local helper expanding `pkg` → `pkg` + `pkg/**` is now
> redundant — `check boundaries` notes it; delete it. Violation line numbers
> also moved: every import after line 1 used to be reported one line early.

## Exemptions and exceptions

```ts
defineBoundaryRule({
  id: 'app.no-legacy-sdk',
  title: 'App code must not import the legacy SDK',
  from: ['src/app/**', '!src/app/**/*.stories.tsx'],
  excludeTests: true,
  exemptFiles: ['src/app/migration/**'],
  forbiddenImports: ['@acme/legacy-sdk'],
  exceptions: [
    { path: 'src/app/bridge.ts', target: '@acme/legacy-sdk', reason: 'ADR-12: the one sanctioned bridge' },
  ],
});
```

- **Exempt files are scanned, and their violations are SUPPRESSED** — listed
  under `suppressed[]` (`reason: 'exempt-file'`) and counted in the summary
  (`N suppressed (a exempt-file, b exception)`), never dropped. A
  silently-dropped exemption is indistinguishable from a stale glob.
- **A `!` in `from` EXEMPTS here; on the gate planes it EXCLUDES** (round 12).
  One parser (`parseGlobList`, `@shrkcrft/core`) splits every glob list, so a
  `!` is the same syntax everywhere; the planes differ only in what a negation
  does. Here the file stays scanned and its violations are suppressed and
  counted; on a wiring / policy / registry / baseline / generated /
  doc-reference list the file is out of scope (see
  [negation globs](gate-rules.md#negation-globs-round-12)). Both share one
  liveness rule: a negation is alive iff it removes at least one file from its
  own positive set. A bare `!` used to be dropped silently; it is now a
  validation error, like `!!x` and a `from` of exemptions only.
- **An exception allows one (path, target) pair** — `path` is matched like
  `from`, `target` with the rule's forbidden-pattern semantics (alias
  candidates included), so under package semantics a bare target also excuses
  that package's subpaths (`target: '@acme/legacy-sdk'` covers
  `@acme/legacy-sdk/client`). Write the deepest subpath you mean;
  `forbiddenMatch: 'exact'` makes targets exact too. A `reason` is required.
- **Overlapping exceptions are all credited.** When more than one exception
  matches a violating edge (an area-wide `src/app/**` next to a file-level one
  for the same target), every one of them counts as matching it, and the
  violation is suppressed once (attributed to the first). Only an exception
  that matches NO violating edge is stale.
- **A stale exception fails the run.** An exception that suppressed no
  violating edge in the run is an ERROR (`stale exception: …`), exit `1`,
  reported at the rule's source file. An exception list that cannot rot loudly
  rots into permanent silent width. In `--changed-only` mode a stale
  exception fails a changeset that edits (or escalates) its rule, and is legacy
  otherwise.
- An exemption glob YOU wrote that exempts nothing is a dead unit (below);
  the `excludeTests` shorthand may be vacuous.

`why <file>`, the rule-graph bridge and the evaluator all decide "is F in R's
scope" through one function (`boundaryRuleCovers`), so none of them can claim a
rule applies to a file it exempts.

## Dead rules and units

A rule that enforced nothing is never reported as evaluated.

- **A rule whose `from` globs match no scanned file** (a directory rename) is
  `skipped` with the reason (`from globs matched 0 of N scanned files: …`) —
  exit `1` for an `error` rule (`failOnEmpty`), `2` for a warning rule. It never
  counts in `rulesEvaluated`. Nor does a rule accepted as intended-empty (every
  `from` inclusion marked `expectEmpty`, no file matched — round 13): it
  examined 0 files, so it is counted apart (`rulesAcceptedEmpty`, and the
  coverage row's `acceptedAsIntendedEmpty`) and printed as `N evaluated, M
  accepted as intended-empty`. In the gate envelope a `failOnEmpty` rule is
  `status: 'failed'` (its `skipReason` kept) — the wiring plane's mapping, so
  `gate.failed` counts the rule that failed the run; a warning rule's skip stays
  `skipped`.
- **Every rule carries coverage** — scope globs that reached a governed file,
  of the scope globs it declares. A dead glob next to a live sibling makes the
  rule `partial` and the run `2` (`NOT VERIFIED: <rule>: examined 1 of 2 scope
  globs, …`), even with no violations.
- **Dead selector units** are listed per unit with a reason: a forbidden or
  allowed pattern that matches no import anywhere in the repo, no
  workspace/dependency/builtin package name, no tsconfig alias and no file —
  `typo, retired target, or a target that does not exist yet (see expectEmpty)`;
  an allowed pattern a forbidden one shadows (`cause: 'shadowed'`); an authored
  exemption that exempts nothing. A unit dead by its shape (`cause`) is proved
  from the rule alone, so an unread file never hides it. They
  are warnings — a deliberate "never adopt X" guard on a package in your
  dependencies is not dead — and `--fail-on-dead-units` makes them exit `1`.
  (The same flag name as the gate planes'.) At exit `0` the verdict line names
  them — `Verdict: no boundary violations — N dead selector unit(s) reported
  above (--fail-on-dead-units to fail on dead units).` — never a `✓`; so does a
  warning violation (`no blocking boundary violations — N warning(s) …`). The
  `✓` sentence is printed only when nothing was reported above.
- **A fence written ahead of its code** (round 13): mark the unit —
  `forbiddenImports: ['@scope/kernel-*', { pattern: '@scope/plugin-react',
  expectEmpty: true, reason: 'ADR-7' }]`. The marker works on `from` (inclusions
  and `!` exemptions), `exemptFiles`, `forbiddenImports` and `allowedImports`. A
  marked unit whose target does not exist yet is **intended-empty**: never
  dead, never a failure, and printed as `accepted by expectEmpty: …` under the
  `✓`. A rule whose only `from` glob is planned is accepted, not a `failOnEmpty`
  failure. When the target appears (a package name, a dependency, an alias, a
  file or an import) the marker **went live**: `expectEmpty is stale: … — the
  fence went live; remove expectEmpty`, with the `✓` withheld. `--fail-on-dead-units`
  and `--strict` fail on a local went-live marker; a pack's is INFO (its own
  `INFO — pack expectEmpty markers that went live` block, the `✓` kept) and
  never fails. The acceptance is printed wherever a boundary run is settled:
  `quality`'s notes, and under the verdict of `finish`, `drift` and
  `architecture violations`. A rule-level `expectEmpty` / `allowDead`, an unknown rule key, a marker
  on a defective / redundant / shadowed pattern and an object
  `exceptions[].target` are refused at load (errored rule). The full guide:
  [intended-empty.md](intended-empty.md).

## Imports are read from code

The scanner reads imports through the one import parser (shared with the
`import-edges` DSL extractor), zoned by the code-zone lexer:

- a `// import …` line, a `/* import … */` block, an import inside a doc
  comment's code fence, and `"import x from 'y'"` inside a string are NOT edges;
- a real import whose clause holds a comment (`real, // don't use …`) IS found;
- a `'…'` / `"…"` literal ends at a newline, so a quote inside a regex literal
  can no longer hide the rest of the file;
- a regex literal is one opaque code span: the backtick in `` /`/g `` and the
  `/*` in `/\/*$/` open nothing, so an `import()` / `require()` after them is
  still read (they used to open a phantom template literal / block comment that
  hid it — every surface then passed over a forbidden import);
- `--include-comments` reads the raw text instead (the escape hatch). An import
  clause never crosses a backtick there either, so a doc comment's
  `` `shrk import <format>` `` cannot claim the next real import's line.

Measured against the TypeScript compiler over this repo: 79 phantom edges and
1 missed import before, 0 and 0 after. Every consumer of the import scan —
drift, impact, review packets, the architecture map — gets the same answer.

## Commands

```bash
shrk check boundaries
shrk check boundaries --json
shrk check boundaries --strict                  # warnings fail too
shrk check boundaries --rule <id>               # one rule (an unknown id exits 3)
shrk check boundaries --rule-file <path>        # evaluate ONLY a candidate rule file
shrk check boundaries --diff-against <path>     # dry run: what a candidate set adds / removes
shrk check boundaries --changed-only            # see docs/boundaries-changed-only.md
shrk check boundaries --include-comments        # raw-text imports
shrk check boundaries --fail-on-dead-units      # a dead selector unit, or a local went-live expectEmpty marker, fails
shrk check boundaries --allow-empty             # accept zero rules / an empty selection explicitly
shrk check boundaries --help
```

An unknown flag is rejected (exit `3`) — `--rules` used to be swallowed as a
silent `true`.

### `--rule-file <path>` — try a rule before committing it

Loads the file through the same loader `boundaryFiles` use and evaluates ONLY
its rules. A missing file, one that throws, or one with no valid rule is exit
`3`; invalid rules next to valid ones are errored rows. Composes with `--rule`,
`--json`, `--include-comments` and `--changed-only` (every candidate rule is
escalated — it is new by definition). Not available over MCP: loading a rule
file executes it.

### `--diff-against <path>` — the number a rule author needs

Evaluates the active rule set and the proposed one against ONE scan with the
gate's own engine. The proposal is an id overlay: a candidate rule with an
active id REPLACES it, a new id ADDS a rule. Reports, per rule,
`+added / -removed / =unchanged`, the rules added and replaced, and an
edge-level summary (edges flagged by any rule, before and after — so a rename is
not churn). Exit `1` when the proposal adds an error-severity violation, or a
candidate rule matches nothing and fails on empty (it would fail the gate — its
row is `failed`, as in the gate itself), `2` when a candidate rule's scope is
otherwise dead (its delta proves nothing), `0` otherwise. JSON schema
`sharkcraft.boundary-rule-diff/v1`.

`--strict` does not apply to the diff: it settles on error-severity
violations, dead candidate scopes and `--fail-on-dead-units` only, so a warning
violation the proposal adds is reported and never promoted to a failure (and a
local went-live marker fails the diff only under `--fail-on-dead-units`). The
usage line says so. Judge the candidate alone under `--strict` with `check
boundaries --rule-file <path> --strict`.

## Exit codes

| Exit | When |
|---|---|
| 0 | every selected rule examined its whole scope and none reported an error violation — including a rule whose planned units are marked `expectEmpty` (the acceptance is printed) |
| 1 | an error violation (or a warning under `--strict`), an errored rule (a malformed marker, a rule-level `expectEmpty`, an unknown rule key), a stale exception, a `failOnEmpty` rule that matched nothing, a dead unit under `--fail-on-dead-units`, a local went-live `expectEmpty` marker under `--fail-on-dead-units` or `--strict` |
| 2 | zero rules loaded, a rule that checked nothing, a partly-examined scope (a dead `from` glob, an unreadable governed file), an empty changed selection, a suppressed escalation — `NOT VERIFIED`, never a pass |
| 3 | an unknown flag, an unknown `--rule`, a missing / unloadable `--rule-file` or `--diff-against` |

`--json` carries `exitCode`, the settled `verdict`, per-rule `coverage` (each
`fromGlobs` / `forbidden` / `allowed` / `exemptions` row with its `state`:
`live`, `dead`, `intended-empty`, `went-live` or `unproven`), `skipped`,
`deadUnits` (unmarked dead units only), `intendedEmpty`, `wentLive`,
`failingUnits`, `accepted`, `suppressed`, `staleExceptions`, `loadIssues`,
`configuration` (when nothing loaded: where the sharkcraft dir resolved and
why no rule loaded) and the shared `gate` envelope (`docs/gate-json.md`) with
one `boundary` rule per selected rule (its `unitAcceptance` and `units` when it
has marked or dead units). `--diff-against` carries `intendedEmpty`,
`wentLive` and `failingUnits` for the candidate rules, settled the same way.

## MCP

```
check_boundaries             # full evaluation — the same engine and verdict as the CLI
get_changed_boundary_report  # changed-scope evaluation, with rule escalation
list_boundary_rules          # all registered rules + source, effective severity + forbiddenMatch
get_boundary_rule            # one rule + its effective semantics (below)
get_import_graph_summary     # files scanned, internal/external counts
```

All read-only. `check_boundaries` and `get_changed_boundary_report` run THE
boundary orchestrator the CLI runs (tsconfig aliases resolved — they used not
to be), and return `verdict` (`pass | fail | not-verified | usage-error`) and
`exitCode`. The MCP server never writes.

`list_boundary_rules` rows and `get_boundary_rule` carry the EFFECTIVE
`severity` (unset = `error`) and `forbiddenMatch` (`package` = each bare pattern
also covers its subpaths · `exact` = entrypoint only) through the helpers the
evaluator and `boundaries explain` read, so an agent can tell that a bare
`@scope/pkg` also forbids `@scope/pkg/sub`. `get_boundary_rule` adds
`failOnEmpty`, `redundantForbidden` and `shadowedAllowed`.

Round 13: `check_boundaries` takes `failOnDeadUnits` (the CLI's
`--fail-on-dead-units`: a dead unit or a local went-live `expectEmpty` marker
fails; a pack marker never) and returns `intendedEmpty`, `wentLive`,
`failingUnits` and `accepted` beside `deadUnits`, each coverage row with its
`state`. `list_boundary_rules` and `get_boundary_rule` add `expectEmptyUnits`
(the pattern lists stay plain strings); `get_boundary_rule` adds one
`expectEmpty marker: <list> <unit> — <reason> (state: see check_boundaries)`
line per marker in `expectEmptyMarkers`, as `boundaries explain` prints it — a
DECLARATION, never a state: whether a marked unit is intended-empty or went
live is what `check_boundaries` settles. `get_changed_boundary_report` carries
the same `deadUnits`, `intendedEmpty`, `wentLive`, `failingUnits` and
`accepted` in its `typescript` block as the changed-scope CLI run prints.

## tsconfig path aliases

The checker reads `tsconfig.base.json` / `tsconfig.json` from the project
root. `compilerOptions.paths` are resolved against every import specifier:

- Exact aliases (`"@app/adapter-core": ["packages/app/adapter/adapter-core/src/index.ts"]`)
- Wildcard aliases (`"@app/*": ["packages/app/*/src/index.ts"]`)

A rule's `forbiddenImports` / `allowedImports` patterns are matched
against the **literal** specifier *and* the **resolved** path. Write your
rule against project paths and it will catch alias-prefixed imports too:

```ts
{ from: ['packages/app/core/**'], forbiddenImports: ['packages/app/ui'] }
```

Violations include `resolvedVia` when the match came via the alias map.

## Limitations

- The import reader is a lexer, not a compiler: a regex literal right after
  `)` (`if (x) /re/.test(s)`) is read as a division — i.e. with the
  pre-round-11 lexing of its body — and a dynamic `import()` inside a template
  literal's `${…}` is not seen.
- Module resolution does NOT chase `index.ts` / `.d.ts` / `node_modules` — only
  the path alias map is honored.
