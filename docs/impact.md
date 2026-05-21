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
- `risk` (`low|medium|high|critical`) + `riskReasons`.
- `truncations` — lists that exceeded `--limit`.
- `diagnostics` — warnings emitted during analysis.

## Risk classification

A simple weighted score combining direct/transitive dependent counts,
public-API touches, boundary rule density, package count, ownership
review status, missing tests, core touches, policy surface touches, and
area span. Returns one of `low | medium | high | critical`
plus a list of `riskReasons` for transparency.

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

## Limitations

- Reverse-dependency closure uses the workspace import graph; node_modules
  packages, dynamic `require`, and non-JS imports are skipped.
- Construct / pack policy data is best-effort and depends on the registries
  being warmed (impact warms them automatically).
- `--specifier` resolves via tsconfig path aliases only; bare npm package
  names without aliases will not resolve to files.
