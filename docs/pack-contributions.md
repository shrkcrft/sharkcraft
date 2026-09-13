# Pack contributions (reference + R38 inventory v2)

Every contribution a SharkCraft pack can ship via its manifest
`contributions.*` block. All are optional. All are static data — packs
never run code on the engine's behalf.

## R38 — inventory v2

`buildPackContributionsInventoryAsync(inspection)` does
**structural-first** extraction via the dedicated per-kind registries
(knowledge / rules / paths / templates / pipelines / playbooks /
conventions / helpers / routing hints / contract templates /
migration profiles). For kinds without a dedicated loader, regex
extraction stays in place but is tagged
`extractionMode: 'regex-fallback'` with `confidence: 'medium'`. The
regex fallback also dedupes against `(kind, packageName||local, id)`
so the same logical pack contribution doesn't double-count when
reachable from multiple paths (`node_modules/...` vs the dev source).

`shrk packs contributions` / `shrk packs conflicts` are the CLI
surfaces; MCP `get_pack_contributions` / `get_pack_conflicts` return the same
async inventory.

**Round 12 (12.1e):** every manifest slot that has a loader is a contribution
kind and is listed STRUCTURALLY — registration hints, presets, boundary rules,
scaffold patterns, constructs and construct facets, search tuning, decisions,
policy checks, feedback rules, context / agent tests, delegate recipes,
framework extractors and the seven gate planes were scraped by regex or not
listed at all. The registry kinds come from ONE run of THE registry-outcome
table (`collectRegistryOutcomes`, contribution-load-failures.ts). Regex
extraction remains only for a file whose loader returned no entry (`warning`)
or that failed to load (`error`) — a regex id is never `ok`.

### Extraction modes and load failures (round 11)

Every entry carries how its id was derived, and every render prints it — a
fallback is never invisible:

```
  extraction    12 structural · 3 regex-fallback (unverified) · 0 file-only
By kind:
  knowledge                       3  (structural 1 · regex-fallback 2)
Load failures (1):
  ✗ node_modules/@acme/pack/k-broken.ts  [knowledge, @acme/pack] — Expected "]" but found "'b'"
      regex-scraped ids NOT loaded: pack.broken.one
```

- A contribution file the module loader **cannot import** is a load failure:
  its regex-scraped ids are `validation: 'error'` ("does NOT take effect"),
  and the file is one `invalid-contribution` **error** conflict. The JSON
  carries `loadFailures[]` (file, kind, pack, first line of the error, scraped
  ids) and `extractionTotals`. The failure map is one authority,
  `collectContributionLoadFailures` — the inspection-time loader diagnostics
  plus the async registries' `load-failed` issues.
- A regex id of a kind whose loader returned nothing for that file is a
  `warning` ("regex-derived; the loader returned no entries").
- The sync `buildPackContributionsInventory` does not consult the loaders:
  every regex id there is `warning` ("unverified: loader not consulted") unless
  the inspection-time loader imported the file cleanly. Prefer the async one.
- `sourceFile` is a pure function of the repo (pack-relative registry paths
  resolve against the pack root, never `process.cwd()`).
- `shrk packs contributions` exits **1** when an error-severity conflict exists
  (a load failure, a duplicate id), like `shrk packs conflicts` — and, since
  round 12, on an entry a loader rejected, and **2** when only unresolvable
  references remain (see "The contributions report" below).

Each slot's loader, and what makes it REFUSE one declared entry (round 12,
12.1 — every refusal is a rejected entry on every surface, never a silent
drop):

| Slot | Kind | Loader | Refused when |
|---|---|---|---|
| `knowledgeFiles` / `ruleFiles` / `pathFiles` / `pathConventionFiles` / `docsFiles` (`.ts`) | knowledge / rule / path / path / docs | the TypeScript knowledge loader | a list member (or the `default` object) carrying a string `id` or `title` lacks a string `id` + `title` + `content`; a different object reuses an id |
| `templateFiles` | template | `loadTemplatesFromFile` | no string `id` + `name`; a reused id (a missing `tags` / `scope` / `appliesWhen` / `variables` is normalised to `[]`) |
| `pipelineFiles` | pipeline | `loadPipelinesFromFile` | no string `id` / `title` / `description`, or no `steps` array; a reused id |
| `presetFiles` | preset | `loadPresetsFromFile` | `validatePreset` fails |
| `boundaryFiles` | boundary | `loadBoundaryRulesFromFile` | `validateBoundaryRule` fails (also an ERRORED rule on `shrk check boundaries`) |
| `wiringRuleFiles` / `registryFiles` / `registrationGraphFiles` / `policyRuleFiles` / `reusePrimitiveFiles` / `baselineFiles` / `generatedArtifactFiles` / `docReferenceFiles` | wiring-rule / registry / registration-idiom / policy-rule / reuse-primitive / baseline / generated-artifact / doc-reference | the pack-plane merge seam (`resolveProjectConfig`) | the plane's zod schema fails; a shell `compute.run` / `regen`; a key the local config (or an earlier pack) already provides; an unresolvable `$use` (`docReferenceFiles` is a declared slot since round 13 — its refusals were a diagnostic string only) |
| `contextTestFiles` / `agentTestFiles` | context-test / agent-test | the test runner's loaders | no non-empty `id`, or no string `task` |
| `delegateRecipeFiles` | delegate-recipe | `loadDelegateRecipesFromPacks` | `DelegateRecipeSchema` (the config loader's own) fails; a reused id |
| `scaffoldPatternFiles` | scaffold-pattern | the scaffold-pattern loader | no `id` / `templateId` / non-empty `matchPaths`, or `confidence` not `high` / `medium` / `low`; a reused id |
| `policyCheckFiles` | policy | the policy registry | no non-empty `id` |
| `constructFiles` | construct | `loadConstructsWithIssues` | no non-empty `id` or `type` |
| `constructFacetFiles` | construct-facet | `loadConstructsWithIssues` | no string `id` / `constructId` / `kind` / `value`, or its `constructId` names no loaded construct |
| `playbookFiles` | playbook | `loadPlaybooksWithIssues` | no non-empty `id`, or `steps` is not an array |
| `searchTuningFiles` | search-tuning | `loadSearchTuning` | no non-empty `id` |
| `feedbackRuleFiles` | feedback-rule | `loadFeedbackRulesWithIssues` | no non-empty `id`; a reused id |
| `decisionFiles` | decision | `loadTsDecisionsWithIssues` | no non-empty `id`; a reused id. The same loader refuses a local Markdown record (`sharkcraft/decisions/*.md`, `docs/adr/*.md` — round 15 follow-up) whose `id` / `title` / `status` / `date` or top-level structure THE parser cannot read (a key the record does not read is skipped unparsed), whose `---` block never closes, or whose `id` / `title` / `status` / `date` is not a single value (a block list — an inline `title: [WIP]` is the title `[WIP]`, round 15 closing) |
| `contractTemplateFiles` | contract-template | `loadAllContractTemplates` | no string `id` / `title`, a foreign `schema`, or no `defaultForbiddenFilesDetailed` array; a reused id |
| `migrationProfileFiles` | migration-profile | `loadMigrationProfiles` | no string `id` / `title`, or no `checks` array; a reused id |
| `conventionFiles` | convention | `loadConventions` | `validateConvention` errors (a missing `severity`, …); a reused id |
| `helperFiles` | helper | `loadPackHelpers` → the helper catalog | `validatePackHelper` errors; a reused or built-in id |
| `taskRoutingHintFiles` | task-routing-hint | `loadTaskRoutingHints` | `validateTaskRoutingHint` fails; a reused id |
| `registrationHintFiles` | registration-hint | `loadRegistrationHints` | `validateRegistrationHint` fails; a reused id |
| `frameworkExtractorFiles` | framework-extractor | `loadPackExtractors` (framework-scanners); the inspector reads it through the same shared predicate | no string `framework`, or `fileMatches` / `extract` not functions; a reused framework name (a built-in name is refused by the runtime loader, which alone knows the built-ins) |
| `mcpToolFiles` / `aiProviderFiles` | — | reserved — no loader | — |

## Rejected entries (round 12)

A declared entry its loader REFUSED used to be a silent `continue`: the file
compiled (the pack build is a transpile), the `list` verb printed the
survivors, and every doctor reported zero errors. Every loader now returns the
refusal next to its entries as an `IRejectedEntry` (`@shrkcrft/core`: `file`,
`index` — `-1` for a single-object export — `exportName`, `entryId`, EVERY
`<field>: <message>` reason, and `cause` `invalid` / `duplicate-id`), and ONE
channel carries them: `collectContributionRejections(inspection,
(await collectRegistryOutcomes(inspection)).rejections)`. The conservation law
holds per file: **accepted + rejected = declared**. One wording on every
surface (`formatEntryRejection`):

```
'conv.b' (default[8]) — severity: severity must be one of: info, warning, error (got undefined)
```

Where a rejection shows:

- the kind's `list` verb — after the list, `⚠ 2 entries rejected from
  node_modules/@acme/pack/conventions.ts: 'conv.b' (default[8]) — severity: …;
  'conv.j' (default[9]) — … → shrk conventions doctor`. The exit stays `0` (a
  list is no verdict); under `--json` the stdout array is unchanged and a
  one-line `note:` goes to stderr. Wired into `knowledge`, `templates`,
  `pipelines`, `presets`, `boundaries`, `scaffolds`, `policy`, `constructs`,
  `playbooks`, `search tuning`, `feedback rules`, `contract template`,
  `profiles`, `conventions`, `helper` and `registrations` list. A contribution
  FILE that failed to load is named the same way — `⚠ sharkcraft/conventions.ts
  failed to load (<message>) — nothing in it is listed` (a stderr `note:` under
  `--json`) — and `conventions list` no longer offers that file as the place to
  contribute (`knowledge` and `helper` list keep their own load-failure line);
- `shrk self-config doctor` — `<kind>-invalid` / `<kind>-duplicate-id`, ERROR
  (exit 1), one finding per failing field;
- `shrk packs list` / `packs get` — per-kind `entries:` counts and the
  `REJECTED-ENTRIES` mark (`--json` `entryCounts`);
- `shrk packs doctor` — `contribution-entries-rejected` per file (error);
- `shrk packs contributions` — a `Rejected entries (N)` block, the `By file:`
  report, JSON `rejections[]` and `extractionTotals.rejected`. The regex never
  runs on a file a loader READ (it accepted or refused an entry of it), so a
  refused id is never a contribution row, a `totals` count or half of a
  duplicate; an id scraped from a file that failed to load (`validation:
  'error'`) is never grouped into a duplicate either — its load failure is the
  error;
- `shrk packs test --load` — `asset-entry-rejected`, from the same runtime
  loader (see docs/pack-authoring.md);
- MCP — `get_pack_contributions` (`rejections`, `report`), `list_packs` /
  `get_pack` (`entryCounts`).

Not a rejection: PRECEDENCE — a local knowledge entry, template, pipeline,
preset or boundary rule overriding a pack one (reported as a shadowing
warning) — and a module's helper values (`export const TAGS = ['x']`, an
object with no string `id` or `title`).

## The contributions report (round 12)

`shrk packs contributions` ends with `By file:` — every contributed file,
local and pack: entries declared · accepted · rejected, each rejected entry
with its reasons, and the references it declares that cannot be checked
because their kind's registry is empty here (`registry-empty`) or can never
be filled (`undeclarable-kind`, from THE declarability table):

```
By file (3): 12 declared · 10 accepted · 2 rejected · 1 unresolvable reference(s)
  ✗ node_modules/@acme/pack/conventions.ts  convention [@acme/pack]  10 declared · 8 accepted · 2 rejected
      rejected      'conv.b' (default[8]) — severity: severity must be one of: info, warning, error (got undefined)
      rejected      'conv.j' (default[9]) — severity: severity must be one of: info, warning, error (got undefined)
  ~ node_modules/@acme/pack/registration-hints.ts  registration-hint [@acme/pack]  1 declared · 1 accepted · 1 unresolvable reference(s)
      unresolvable  reg.x discovery.conventionIds → convention 'conv.web' — this kind's registry is empty here
  ✓ sharkcraft/playbooks.ts  playbook  1 declared · 1 accepted
```

- **Exit** — `0` everything accepted and every reference checked · `1` an
  error-severity conflict, a file that failed to load, or a rejected entry ·
  `2` only unresolvable references remain (NOT VERIFIED, settled through
  `settleVerdict`; `--allow-empty` is not a valve for them) · `2` no
  contributed file is in view — an empty project, or a `--pack` / `--kind`
  that selects no file — because nothing was examined (`--allow-empty`
  accepts an empty view explicitly, printed) · `3` an unknown `--kind` (not a
  contribution kind — `conventions` is a typo of `convention`) or `--pack` (no
  discovered pack), naming the known values and the nearest. `--pack` /
  `--kind` narrow the files AND the verdict.
- **JSON** — `report: { files[], totals, referenceCoverage? }` next to the
  inventory (`report.totals` is nested because the inventory already carries a
  per-kind `totals`), plus `exitCode` / `verdict` / `shortfalls` / `accepted`.
  MCP `get_pack_contributions` returns the same `report`; its `kind` is the
  contribution-kind enum (inputSchema and the strict wire validator), and an
  unknown `kind` or `pack` is `invalid-input`, never an empty report.
- **One authority** — the unresolvable references are the self-config doctor's
  OWN reference probes (`collectUnresolvableReferences`); the doctor carries
  the same list as `unresolvableReferences`, so the two cannot disagree.

## Loading order

For every slot:

1. Engine built-ins first (where any exist).
2. Local files under `sharkcraft/` next.
3. Pack-discovered files last.

Duplicate ids are reported as doctor errors (not silent overrides). Use
`shrk profiles doctor`, `shrk packs doctor`, or kind-specific doctor
commands to surface them.

## Source attribution

Most loaders return entries tagged with `source: 'builtin' | 'local' |
'pack'` and (for pack entries) `packageName` + `sourceFile`. The CLI and
MCP surfaces expose these fields so a user can tell where a
contribution came from.

## Signing

Every contribution slot participates in the manifest HMAC signature.
Add or modify a contribution → re-sign with `shrk packs sign`:

```bash
SHARKCRAFT_PACK_SECRET="<secret>" shrk packs sign <manifest.signed.json>
```

If the secret is missing, the engine reports a stale signature honestly.
Never fake-sign.

## R51 — Loader safety for pack assets

Every TS-asset loader (knowledge / rules / paths / templates /
pipelines / presets / boundaries) goes through a bounded
`safeImport()` wrapper in `@shrkcrft/core`. This guarantees:

- **No infinite hangs.** Each `import()` is raced against a per-asset
  timeout (default 8000ms; override via `--loader-timeout <ms>` on
  `shrk inspect` / `shrk doctor`).
- **No silent exits.** A failed load is reported as a doctor error
  with the file path, contribution kind, elapsed ms, error message,
  and a suggested next command.
- **No double-imports of broken files.** The inspector creates one
  `IImportContext` per call; the same absolute path is imported at
  most once, so two contribution entries pointing at the same file
  cannot trigger Bun's pathological second-import-of-a-failed-module
  behaviour.

### How large packs should structure contribution files

- Prefer one logical file per contribution kind (one `rules.ts`,
  one `templates.ts`, etc.). The engine no longer hangs on a 2k-LOC
  asset, but smaller files are still nicer to review.
- **Every top-level `export const` must have a unique identifier.**
  A duplicate `export const X` at parse time causes a
  `BuildMessage: "X" has already been declared` error. Bounded
  loading catches this and surfaces it cleanly, but the pack stays
  broken until the duplicate is removed.
- If a pack's TS asset takes >1.5s to load, the inspector tags it
  `slow` in `loaderDiagnostics`. Treat this as a hint to split or
  simplify — but it is never fatal.

### What happens when a pack asset fails to load

| Engine outcome | What the user sees |
|---|---|
| First inspect on a broken asset | Doctor error: `Loader failed (<kind>)` with the file path, error message, and `fix: shrk packs doctor --release`. Inspect prints a `Loader diagnostics` block above the next-step hints. Cache writes a `failed` entry. |
| Repeated inspect on the same broken asset | Doctor error stays. The diagnostic records `cached-skip` so subsequent runs are fast. The cache prevents re-triggering the underlying hang. |
| `--no-cache` | Cache is bypassed; the loader retries (and may time out again). Useful when iterating on the pack. |
| File fixed (mtime changes) | The cache fingerprint no longer matches → cache invalidates → next inspect re-imports the file. |

### Debugging slow inspection

```bash
shrk --cwd <repo> inspect --debug
shrk --cwd <repo> doctor --debug
```

Both surfaces print a `Loader timing` block with one line per asset:

```
  kind        status    elapsed   count   path
  rules       failed    2ms       0       …/rules.ts
  templates   ok        2ms       26      …/templates.ts
```

For machine consumption, `shrk inspect --json` includes a `loader`
sub-object with `inspectionElapsedMs`, `cacheEnabled`, `cacheDir`, and
the full `diagnostics` array.

### Cache invalidation rules

- The cache lives under `<projectRoot>/.sharkcraft/cache/inspector/v1/`
  (already covered by the umbrella `.sharkcraft/cache/` entry in
  `.gitignore`).
- An entry is fresh iff `mtimeMs` and `sizeBytes` match the file on
  disk. Any edit (even a whitespace change that changes mtime)
  invalidates the entry.
- The cache stores **metadata only** — file path, status, elapsed ms,
  warning count, error message, ids (when extractable). It does not
  cache the imported module itself; modules with function bodies
  (templates, pipelines) are always re-imported when their bodies
  are needed.
- Cache writes are best-effort. A read-only filesystem disables the
  cache transparently; the loader still runs.
- MCP tools never enable the cache (read-only contract). `shrk
  inspect` / `shrk doctor` enable it unless `--no-cache` is passed.
