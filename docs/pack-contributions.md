# Pack contributions (reference + R38 inventory v2)

Every contribution a SharkCraft pack can ship via its manifest
`contributions.*` block. All are optional. All are static data — packs
never run code on the engine's behalf.

## R38 — inventory v2

`buildPackContributionsInventoryAsync(inspection)` does
**structural-first** extraction via the dedicated per-kind registries
(knowledge / rules / paths / templates / pipelines / playbooks /
plugin-lifecycle profiles / conventions / helpers / routing hints /
contract templates / migration profiles). For kinds without a
dedicated loader, regex extraction stays in place but is tagged
`extractionMode: 'regex-fallback'` with `confidence: 'medium'`. The
regex fallback also dedupes against `(kind, packageName||local, id)`
so the same logical pack contribution doesn't double-count when
reachable from multiple paths (`node_modules/...` vs the dev source).

`shrk packs contributions` / `shrk packs conflicts` are the CLI
surfaces.

| Slot | Default-export shape | Loader |
|---|---|---|
| `knowledgeFiles` | `IKnowledgeEntry[]` | `loadKnowledge` |
| `ruleFiles` | `IRule[]` | `loadRules` |
| `pathFiles` | `IPathConvention[]` | `loadPaths` |
| `templateFiles` | `ITemplateDefinition[]` | `loadTemplates` |
| `pipelineFiles` | `IPipeline[]` | `loadPipelines` |
| `docsFiles` | doc files (md) | doc indexer |
| `presetFiles` | `IPreset[]` | preset loader |
| `boundaryFiles` | `IBoundaryRule[]` | boundary loader |
| `contextTestFiles` | `IContextTest[]` | context-test loader |
| `agentTestFiles` | `IAgentContractTest[]` | agent-test loader |
| `mcpToolFiles` | (reserved) | — |
| `aiProviderFiles` | (reserved) | — |
| `scaffoldPatternFiles` | `IScaffoldPattern[]` | scaffold-pattern loader |
| `policyCheckFiles` | `IPackPolicyCheck[]` | policy loader |
| `constructFiles` | `IConstructInput[]` | construct loader |
| `constructFacetFiles` | `IConstructFacet[]` | construct loader |
| `playbookFiles` | `IPlaybookInput[]` | playbook loader |
| `searchTuningFiles` | `ISearchTuning[]` | search-tuning loader |
| `feedbackRuleFiles` (R30+) | `IFeedbackRule[]` | feedback loader |
| `decisionFiles` (R30+) | `IDecision[]` | decisions loader |
| `pathConventionFiles` (R31) | `IPathConvention[]` | paths loader |
| `pluginLifecycleProfileFiles` (R32) | `IPluginLifecycleProfile[]` | `loadPluginLifecycleProfiles` |
| `contractTemplateFiles` (R32) | `IAgentContractTemplate[]` | `loadAllContractTemplates` |
| `migrationProfileFiles` (R32) | `IMigrationProfile[]` | `loadMigrationProfiles` |
| `conventionFiles` (R32) | `IConvention[]` (reserved) | — |

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
