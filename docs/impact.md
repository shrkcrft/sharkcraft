# Impact analysis (`shrk impact`)

`shrk impact` answers "what does changing this break?" using SharkCraft's
import graph, area map, boundary rules, ownership data, and policy engine.

## Inputs

```
shrk impact <fileOrSpecifier>            # positional: file path or '@scope/x' specifier
shrk impact --file <path>
shrk impact --specifier <importSpecifier>
shrk impact --since <ref>                # files changed since git ref
shrk impact --staged                     # staged changes only
shrk impact --files a,b,c
shrk impact --plan <plan.json>           # changes from a saved plan
shrk impact --bundle <bundleId>          # affected files + plan targets
```

Optional flags:

- `--max-depth N` — cap transitive closure depth (default 5).
- `--limit N` — cap each list (default 200; over-the-limit lists are reported
  in `truncations`).
- `--json` — emit the full `IImpactAnalysis` payload (schema
  `sharkcraft.impact-analysis/v2`).

## What the report contains

- `inputKind` — which flag combination produced the file list.
- `normalizedTargets` — files / paths the report is about.
- `directDependents` — files that import a target directly.
- `transitiveDependents` — reachable via repeated importer edges.
- `dependencyPathExamples` — short, capped example chains.
- `affectedAreas` / `affectedPackages` / `affectedPathConventions` —
  high-level location summaries.
- `potentialBoundaryRisks` — boundary rules that may fire.
- `affectedPolicies` — policy ids likely relevant.
- `affectedOwnership` — owners / required reviewers per file (when
  `ownership.ts` or CODEOWNERS data is available).
- `affectedTemplates` / `affectedPipelines` / `affectedPresets` /
  `affectedConstructs` — registry entries that reference touched paths.
- `likelyTests` — co-located or conventional test files.
- `suggestedTestCommands` / `suggestedValidationCommands` /
  `suggestedReviewCommands`.
- `areaCoverage` — `{ classificationRate, degraded, unclassifiedTargets }`:
  how far the area-derived fields above can be trusted (see below).
- `risk` (`low|medium|high|critical`) + `riskReasons`.
- `truncations` — lists that exceeded `--limit`.
- `diagnostics` — warnings emitted during analysis.

## Risk classification

A simple weighted score combining direct/transitive dependent counts,
public-API touches, boundary rule density, package count, ownership
review status, missing tests, core touches, policy surface touches, and
area span. Returns one of `low | medium | high | critical`
plus a list of `riskReasons` for transparency.

## Area attribution coverage

`affectedAreas`, the boundary risks derived from them, and the `core-area`
reason are only as complete as the **area map** (`shrk repo areas`). Its
built-in pattern table knows one layout (`packages/<core|ui|api>`, `src/…`); a
two-level package root (`libs/<group>/<lib>/…`) classified ~14% of files, and an
unclassified target is invisible to every area-derived signal. So:

- the area map reports `classifiedFiles / totalFiles`, `classificationRate` and
  `degraded` (rate below `areaMap.minClassificationRate`, default 0.5);
- impact carries it as `areaCoverage`, adds the risk reason
  `area-attribution-degraded` (it flags, it never LOWERS the risk), and prints
  `Area attribution: degraded (Z% of repo classified; n/m target(s) unclassified)`
  in text and markdown. Report only — no exit code changes.

Fix it by declaring the project's layout — project patterns run before the
built-in table (and `shrk changes`' area buckets use the same patterns first):

```ts
// sharkcraft.config.ts
export default {
  areaMap: {
    patterns: [
      { kind: 'core', match: ['libs/*/core/**'] },
      { kind: 'ui', match: ['libs/*/ui/**'], id: 'ui-libs' },
    ],
    // replaceDefaults: true,      // drop the built-in table entirely
    // minClassificationRate: 0.6,
  },
};
```

`kind` is one of `core | ui | app | api | tests | docs | infra | generated`
(`unknown` is what an unmatched file gets, never a declaration).

## MCP

`get_impact_analysis` — same payload, read-only.

## Examples

```bash
shrk impact src/services/user.service.ts
shrk impact --specifier "@shrkcrft/inspector"
shrk impact --since main --max-depth 3
shrk impact --bundle 2026-05-13T00-57-50-380Z-generate-a-user-profile-service
```

## Output formats (R12)

```bash
shrk impact <input> --format text|markdown|html|json
shrk impact <input> --format html --output impact.html
shrk impact <input> --tree            # default: include ASCII tree
shrk impact <input> --no-tree         # skip the tree
```

Self-contained HTML uses inline CSS, no JavaScript, dark/light aware. Risk
badge colors: green (low), yellow (medium/high), red (critical).
Markdown / text render the same data, including the dependency tree as a
plain-text drawing.

To render a previously-saved report instead of running impact again:

```bash
shrk impact <input> --format json > /tmp/impact.json
shrk report impact /tmp/impact.json --format html --output /tmp/impact.html
```

The static report site embeds these reports via `shrk report site --impact
<file>` or `--impact-dir <dir>`.

## Graph export (R13)

```bash
shrk impact <input> --graph-format mermaid|dot
shrk impact <input> --graph-format mermaid --graph-output impact.mmd
shrk impact graph <impact-report.json> --format mermaid|dot
shrk report impact <impact-report.json> --format html --include-graph
```

Mermaid renders a `flowchart LR` with risk-colored node classes; DOT
renders a `digraph` ready for `dot -Tsvg`. Truncated transitive
dependents appear as a dashed `… N more dependents omitted` node so the
report still tells the truth.

`--include-graph` on `shrk report impact` embeds the Mermaid/DOT source
into the rendered HTML/Markdown without requiring a browser to render
it.

## Graph in the report site (R14)

```bash
shrk report site --impact /tmp/impact.json --with-impact-graphs --output /tmp/site
```

When `--with-impact-graphs` is set, the report site:

- writes a `impact-<n>.mmd` and `impact-<n>.dot` next to each `impact-<n>.html`;
- inlines both sources into the impact detail page (collapsed by default)
  as plain text in `<pre>` blocks — no `<script>` tags, no remote calls;
- adds the artifacts to the manifest so CI consumers can detect them.

Reviewers can paste the Mermaid into <https://mermaid.live> or run
`dot -Tsvg impact-1.dot > impact-1.svg` locally. SharkCraft never starts
a renderer or fetches anything from the network.

## Optional SVG rendering (R15)

```bash
shrk report site --with-impact-graphs --render-impact-graphs --output /tmp/site
shrk impact src/services/user.service.ts --graph-format mermaid --graph-output /tmp/i.mmd --render-svg
shrk impact graph .sharkcraft/reports/impact.json --format dot --output /tmp/i.dot --render-svg
```

`--render-impact-graphs` / `--render-svg` is an opt-in: SharkCraft never
shells out unless one of those flags is set. The renderer is best-effort:

- Mermaid: tries `mmdc` (mermaid-cli).
- DOT: tries `dot` (graphviz).
- If neither is on PATH, the report-site / CLI degrades gracefully and
  keeps the source-only behaviour.

The CLI prints which renderer was used (or the reason it was skipped:
`renderer-missing`, `renderer-failed`, `source-missing`). The report-site
manifest records both the source artifacts and any SVGs in
`impactSvgFiles` + `impactRenderDiagnostics`.

## Delete safety — `check orphans`

The reverse of impact: after you DELETE a file or export, which surviving files
still import it or reference a symbol it declared? `tsc` misses a deleted barrel
re-export or a string-keyed registration; the code graph doesn't.

```bash
shrk check orphans                 # vs the default branch (origin/main / main)
shrk check orphans --since <ref>   # vs an explicit ref
shrk check orphans --staged        # the staged (index) deletions
shrk check orphans --json          # schema: sharkcraft.deleted-orphans/v1
```

It reads the deleted files from the diff and queries the **pre-edit graph
snapshot** (a not-yet-reindexed delete still carries its inbound edges), so each
surviving importer is reported with `file:line`, alias-resolved (incl. barrel
re-exports). Exit `1` when any orphan survives. Nothing deleted → a loud
`skipped`, never a green pass. The diff is streamed (no `ENOBUFS` on large
changesets). This generalizes `shrk impact --deleted` into a first-class verb.

`shrk impact --deleted` answers the same question from the same scan and
settles the same way: "no orphaned importers" (exit `0`) only when every
deleted source file was checked against an index current for every surviving
importer. An index that never read files changed since it was built, a deleted
source file the index does not know, or nothing deleted is NOT VERIFIED (`2`,
with the same lead and remedy as `check orphans`); `--allow-empty` accepts an
empty scope — never a stale one. `--json` carries `coverage`,
`indexDivergence`, `exitCode`, `verdict` and `shortfalls`.

## The composite "done?" gate — `shrk finish`

`shrk finish` is the single call an agent runs after editing to ask *"is this
changeset safe to complete?"*. It EXECUTES every deterministic changed-only gate
inline — boundaries + import-hygiene + wiring + policy + deleted-orphans — plus
an impact summary, and returns ONE pass/fail (schema `sharkcraft.finish/v1`).

```bash
shrk finish                  # worktree changes (default)
shrk finish --staged         # staged changes
shrk finish --since <ref>    # changes since <ref>
shrk finish --json
```

A sub-gate with no applicable rules (no wiring rules, nothing deleted, …) is
reported as `skipped`, not silently passed. A wiring or policy rule the
changeset SELECTED that examined nothing (a stale glob) is not "no applicable
rules": the sub-gate reports `partial` (the composite is `2`), or `fail` when
`failOnEmpty` makes the empty rule a failure — exactly what `check wiring
--changed-only` / `policy-lint --changed-only` read. A superset of
`diff-check` (which runs only boundaries + imports).

## Limitations

- Reverse-dependency closure uses the workspace import graph; node_modules
  packages, dynamic `require`, and non-JS imports are skipped.
- Construct / pack policy data is best-effort and depends on the registries
  being warmed (impact warms them automatically).
- `--specifier` resolves via tsconfig path aliases only; bare npm package
  names without aliases will not resolve to files.
