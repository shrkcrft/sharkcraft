import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  createImportContext,
  DEFAULT_SAFE_IMPORT_TIMEOUT_MS,
  ERROR_CODES,
  RejectionCause,
  type AppError,
  type IImportContext,
  type IRejectedEntry,
} from '@shrkcrft/core';
import { inspectWorkspace, type IWorkspaceSummary } from '@shrkcrft/workspace';
import {
  DEFAULT_DOC_FILES,
  DEFAULT_KNOWLEDGE_FILES,
  DEFAULT_PATH_FILES,
  DEFAULT_RULE_FILES,
  type ISharkCraftConfig,
  loadProjectConfig,
} from '@shrkcrft/config';

/**
 * The knowledge-bearing files the config loader fills in by DEFAULT. They are
 * optional by nature — a repo without `rules.ts` never asked for one — so only
 * a file the config names BEYOND these is recorded `missing` when absent.
 */
const OPTIONAL_DEFAULT_KNOWLEDGE_FILES: ReadonlySet<string> = new Set([
  ...DEFAULT_KNOWLEDGE_FILES,
  ...DEFAULT_RULE_FILES,
  ...DEFAULT_PATH_FILES,
  ...DEFAULT_DOC_FILES,
]);
import {
  type IKnowledgeEntry,
  type IKnowledgeValidationIssue,
  KnowledgeIndex,
  MarkdownKnowledgeLoader,
  TypeScriptKnowledgeLoader,
  validateKnowledgeEntries,
} from '@shrkcrft/knowledge';
import { RuleService } from '@shrkcrft/rules';
import { PathService } from '@shrkcrft/paths';
import { type ITemplateDefinition, loadTemplatesFromFile, TemplateRegistry } from '@shrkcrft/templates';
import { type IPipelineDefinition, loadPipelinesFromFile, PipelineRegistry } from '@shrkcrft/pipelines';
import { discoverPacks, type IPackDiscoveryResult } from '@shrkcrft/packs';
import { BUILTIN_PRESETS, loadPresetsFromFile, PresetRegistry } from '@shrkcrft/presets';
import { BoundaryRegistry, loadBoundaryRulesFromFile } from '@shrkcrft/boundaries';
import { DoctorSeverity, type IDoctorCheck, type IDoctorResult } from './doctor-result.ts';
import {
  registryLifecycleSkipDirsWarning,
  resolveRegistryLifecycleSkipDirs,
} from './registry-lifecycle.ts';
import { diagnoseActionHints } from './action-hint-diagnostics.ts';
import {
  buildCodeIntelligenceChecks,
  type IGraphDivergence,
} from './code-intelligence-doctor.ts';
import { loadSearchTuning } from './search-tuning-registry.ts';
import { buildDelegateRecipeChecks } from './delegate-doctor.ts';
import {
  computeFileFingerprint,
  createInspectorCache,
  type IInspectorCache,
  type LoaderAssetKind,
} from './inspector-cache.ts';
import {
  DEFAULT_SLOW_LOADER_THRESHOLD_MS,
  LARGE_FILE_THRESHOLD_BYTES,
  type ILoaderDiagnostic,
  type LoaderOrigin,
} from './loader-diagnostics.ts';
import { suggestSurfaceProfile } from './surface-profile-detect.ts';
import {
  boundaryFileLabel,
  boundaryLoadIssuesFromFile,
  classifyLocalBoundaryFiles,
} from './boundary-configuration-status.ts';
import type { IBoundaryLoadIssue } from './boundary-load-issue.model.ts';
import {
  describePackAssetFreshness,
  detectPackAssetFreshness,
  packHasCompiledContributions,
  type IPackAssetFreshness,
} from './pack-asset-freshness.ts';

/**
 * Find SharkCraft packs that live IN the repo but are not discovered (i.e.
 * not linked into node_modules). Discovery scans node_modules; an unlinked
 * in-repo pack is invisible to it, which silently disables every pack
 * contribution. We do a bounded one-level scan of the conventional pack
 * homes rather than a full recursive walk, so this stays cheap on large
 * monorepos. A "pack dir" is one that has a `sharkcraft.plugin.*` manifest
 * (at its root or under `src/`) or a `package.json` with a `sharkcraft`
 * field. Returns only packs whose package name is NOT already discovered.
 */
export function findUnlinkedInRepoPacks(
  projectRoot: string,
  discoveredPackNames: ReadonlySet<string>,
): Array<{ packageName: string; relPath: string }> {
  const out: Array<{ packageName: string; relPath: string }> = [];
  const seen = new Set<string>();
  const manifestRelCandidates = [
    'sharkcraft.plugin.ts',
    'sharkcraft.plugin.mjs',
    'sharkcraft.plugin.js',
    nodePath.join('src', 'sharkcraft.plugin.ts'),
    nodePath.join('src', 'sharkcraft.plugin.mjs'),
    nodePath.join('src', 'sharkcraft.plugin.js'),
  ];
  for (const parent of ['tools', 'packages', 'libs', '.']) {
    const parentAbs = nodePath.resolve(projectRoot, parent);
    let dirs: string[];
    try {
      dirs = readdirSync(parentAbs, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== 'node_modules')
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const dir of dirs) {
      const packRoot = nodePath.join(parentAbs, dir);
      const hasManifestFile = manifestRelCandidates.some((c) =>
        existsSync(nodePath.join(packRoot, c)),
      );
      let packageName: string | undefined;
      let hasSharkcraftField = false;
      const pkgJsonPath = nodePath.join(packRoot, 'package.json');
      if (existsSync(pkgJsonPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
            name?: unknown;
            sharkcraft?: unknown;
          };
          if (typeof pkg.name === 'string') packageName = pkg.name;
          hasSharkcraftField = pkg.sharkcraft != null;
        } catch {
          /* unreadable package.json — ignore */
        }
      }
      if (!hasManifestFile && !hasSharkcraftField) continue;
      if (!packageName || seen.has(packageName)) continue;
      seen.add(packageName);
      if (!discoveredPackNames.has(packageName)) {
        out.push({
          packageName,
          relPath: nodePath.relative(projectRoot, packRoot) || '.',
        });
      }
    }
  }
  return out;
}

export interface ISharkcraftInspection {
  projectRoot: string;
  workspace: IWorkspaceSummary;
  hasSharkcraftFolder: boolean;
  sharkcraftDir: string | null;
  config: ISharkCraftConfig | null;
  configFile: string | null;
  /**
   * Set when a config file EXISTS but could not be loaded — a schema violation
   * (e.g. an unrecognized key), an unresolved `$use`, or an import failure.
   * `config` / `configFile` are then null and every config-declared setting
   * and plane is dropped, so `runDoctor` reports it as an ERROR — never as
   * "no config file".
   */
  configLoadError?: {
    /** Absolute path of the config file that failed, when known. */
    readonly file: string | null;
    /** The loader's own message. */
    readonly message: string;
    /** One line per schema issue (`<path>: <message>`), or the import error. */
    readonly issues: readonly string[];
  };
  knowledgeEntries: IKnowledgeEntry[];
  templates: ITemplateDefinition[];
  pipelines: IPipelineDefinition[];
  warnings: string[];
  sourceFiles: string[];
  validationIssues: IKnowledgeValidationIssue[];
  packs: IPackDiscoveryResult;
  entrySources: ReadonlyMap<string, ISourceInfo>;
  templateSources: ReadonlyMap<string, ISourceInfo>;
  pipelineSources: ReadonlyMap<string, ISourceInfo>;
  index: KnowledgeIndex;
  ruleService: RuleService;
  pathService: PathService;
  templateRegistry: TemplateRegistry;
  pipelineRegistry: PipelineRegistry;
  presetRegistry: PresetRegistry;
  presetSources: ReadonlyMap<string, ISourceInfo>;
  boundaryRegistry: BoundaryRegistry;
  boundarySources: ReadonlyMap<string, ISourceInfo>;
  /**
   * Boundary rules / rule files that were configured but could NOT be
   * evaluated (round 11): an invalid rule, a file that failed to load or
   * exported no array, a `boundaryFiles` entry that does not exist. They used
   * to be warning strings no boundary surface rendered — a fence vanished and
   * `check boundaries` stayed green. Every boundary surface reports each one as
   * an ERRORED rule. Optional so hand-built inspections keep type-checking.
   */
  boundaryLoadIssues?: readonly IBoundaryLoadIssue[];
  /** Per-loader timing + status diagnostics. */
  loaderDiagnostics: readonly ILoaderDiagnostic[];
  /** Total wall-clock ms spent in inspectSharkcraft. */
  inspectionElapsedMs: number;
  /** Whether the inspector cache was enabled for this run. */
  cacheEnabled: boolean;
  /** Directory where the persistent inspector cache lives. */
  cacheDir: string;
  /**
   * Freshness of every valid pack that serves COMPILED contributions
   * (`.js`/`.mjs`/`.cjs`), from THE pack-asset freshness authority — content
   * digests, never mtimes. Packs whose contributions are all TS sources are
   * absent (nothing compiled to go stale). Optional: hand-built inspections
   * omit it.
   */
  packAssetFreshness?: readonly IPackAssetFreshness[];
}

export interface ISourceInfo {
  type: 'local' | 'pack';
  packageName?: string;
  packageVersion?: string;
  file?: string;
}

export interface InspectOptions {
  cwd?: string;
  /** When true, pack discovery also runs HMAC signature verification. */
  verifyPackSignatures?: boolean;
  /** Override for the pack signing secret used during verification. */
  packSecret?: string;
  /** Per-asset import timeout. Default 8000ms. */
  loaderTimeoutMs?: number;
  /**
   * Enables the persistent inspector cache under
   * `.sharkcraft/cache/inspector/v1/`. Default `false` so MCP tools
   * stay strictly read-only — CLI commands opt in by passing `true`.
   */
  useCache?: boolean;
  /** When provided, callers can observe loader diagnostics as they happen. */
  onLoaderDiagnostic?: (d: ILoaderDiagnostic) => void;
}

interface ILoaderTaskContext {
  importContext: IImportContext;
  cache: IInspectorCache;
  diagnostics: ILoaderDiagnostic[];
  onLoaderDiagnostic?: (d: ILoaderDiagnostic) => void;
  cwdProjectRoot: string;
}

function suggestNextCommand(kind: LoaderAssetKind, packName?: string): string {
  if (packName) return 'shrk packs doctor --release';
  if (kind === 'templates') return 'shrk templates doctor';
  if (kind === 'pipelines') return 'shrk pipelines list';
  if (kind === 'rules' || kind === 'knowledge' || kind === 'paths') return 'shrk doctor --debug';
  if (kind === 'boundaries') return 'shrk check boundaries';
  if (kind === 'presets') return 'shrk presets list';
  return 'shrk doctor --debug';
}

function recordDiagnostic(
  ctx: ILoaderTaskContext,
  d: ILoaderDiagnostic,
): void {
  ctx.diagnostics.push(d);
  ctx.onLoaderDiagnostic?.(d);
}

/**
 * A boundary rule file's invalid rules as THE rejection channel's records
 * (round 12, 12.1) — the boundary loader's structured `invalid[]`, one record
 * per rule with every failing field.
 */
function boundaryRejections(
  file: string,
  invalid: readonly {
    readonly index: number;
    readonly ruleId?: string;
    readonly exportName?: string;
    readonly issues: readonly { readonly field: string; readonly message: string }[];
  }[],
): IRejectedEntry[] {
  return invalid.map((inv) => ({
    file,
    index: inv.index,
    // The export the rule array came from — `(default[1])`, one wording with every kind.
    ...(inv.exportName !== undefined ? { exportName: inv.exportName } : {}),
    ...(inv.ruleId !== undefined ? { entryId: inv.ruleId } : {}),
    reasons: inv.issues.map((i) => `${i.field}: ${i.message}`),
    cause: RejectionCause.Invalid,
  }));
}

async function loadAssetTracked(
  ctx: ILoaderTaskContext,
  filePath: string,
  kind: LoaderAssetKind,
  origin: LoaderOrigin,
  packName: string | undefined,
  performLoad: () => Promise<{
    count: number;
    warnings: string[];
    errorMessage?: string;
    /** Entries the loader refused (round 12, 12.1) — recorded on the diagnostic. */
    rejected?: readonly IRejectedEntry[];
  }>,
): Promise<{ count: number; warnings: string[]; errorMessage?: string; skipped: boolean }> {
  const start = Date.now();
  let sizeBytes: number | undefined;
  try {
    sizeBytes = statSync(filePath).size;
  } catch {
    // ignore
  }
  const largeFile = sizeBytes !== undefined && sizeBytes >= LARGE_FILE_THRESHOLD_BYTES;
  const cachedEntry = ctx.cache.get(filePath);

  // Skip when the cache says this asset previously failed and the file
  // hasn't changed since. This is the killer feature that prevents a
  // permanently-broken pack file from hanging every subsequent
  // inspection — and the only signal that lets `doctor` keep telling
  // the truth across runs.
  if (
    cachedEntry &&
    cachedEntry.status !== 'ok' &&
    ctx.cache.isFreshFor(filePath, cachedEntry) &&
    cachedEntry.kind === kind
  ) {
    const elapsedMs = Date.now() - start;
    const message = cachedEntry.errorMessage ?? 'previously failed; cached';
    recordDiagnostic(ctx, {
      filePath,
      kind,
      origin,
      packName,
      elapsedMs,
      status: 'cached-skip',
      count: 0,
      warningCount: 1,
      errorMessage: message,
      cachedStatus: cachedEntry.status,
      deduped: false,
      largeFile,
      sizeBytes,
      slow: false,
      suggestedNextCommand: suggestNextCommand(kind, packName),
    });
    return {
      count: 0,
      warnings: [
        `${kind} loader skipped ${filePath} — cache says previous attempt ${cachedEntry.status}: ${message}`,
      ],
      errorMessage: message,
      skipped: true,
    };
  }

  const dedupedBefore = ctx.importContext.hasSettled(filePath);
  const loaded = await performLoad();
  const elapsedMs = Date.now() - start;
  const slow = elapsedMs >= DEFAULT_SLOW_LOADER_THRESHOLD_MS;
  const errorMessage =
    loaded.errorMessage ??
    (loaded.warnings.find((w) =>
      /^(failed to (?:import|load)|timed out)/i.test(w),
    ) ?? undefined);
  const importResult = ctx.importContext['_settled' as never] as
    | Map<string, { ok: boolean; timedOut?: boolean }>
    | undefined;
  // Defensive: the dedup state is internal to ImportContext. We don't
  // peek into it for correctness — we only use the public surface.
  void importResult;

  const status: 'ok' | 'failed' | 'timeout' = errorMessage
    ? /timed out/i.test(errorMessage)
      ? 'timeout'
      : 'failed'
    : 'ok';

  const fingerprint = computeFileFingerprint(filePath);
  if (fingerprint) {
    ctx.cache.put({
      v: 1,
      filePath,
      mtimeMs: fingerprint.mtimeMs,
      sizeBytes: fingerprint.sizeBytes,
      contentHashPrefix: fingerprint.contentHashPrefix,
      status,
      elapsedMs,
      recordedAtMs: Date.now(),
      kind,
      ids: [],
      warningCount: loaded.warnings.length,
      errorMessage,
      timedOut: status === 'timeout' ? true : undefined,
    });
  }

  recordDiagnostic(ctx, {
    filePath,
    kind,
    origin,
    packName,
    elapsedMs,
    status,
    count: loaded.count,
    ...(loaded.rejected && loaded.rejected.length > 0 ? { rejected: loaded.rejected } : {}),
    warningCount: loaded.warnings.length,
    errorMessage,
    deduped: dedupedBefore,
    largeFile,
    sizeBytes,
    slow,
    suggestedNextCommand:
      status !== 'ok' || slow ? suggestNextCommand(kind, packName) : undefined,
  });

  return { count: loaded.count, warnings: loaded.warnings, errorMessage, skipped: false };
}

export async function inspectSharkcraft(options: InspectOptions = {}): Promise<ISharkcraftInspection> {
  const inspectStart = Date.now();
  const cwd = options.cwd ?? process.cwd();
  const workspace = await inspectWorkspace({ startDir: cwd });

  const importContext = createImportContext({
    timeoutMs: options.loaderTimeoutMs ?? DEFAULT_SAFE_IMPORT_TIMEOUT_MS,
  });
  const cache = createInspectorCache({
    projectRoot: workspace.projectRoot,
    enabled: options.useCache === true,
  });
  const diagnostics: ILoaderDiagnostic[] = [];
  const ctx: ILoaderTaskContext = {
    importContext,
    cache,
    diagnostics,
    onLoaderDiagnostic: options.onLoaderDiagnostic,
    cwdProjectRoot: workspace.projectRoot,
  };

  const cfgResult = await loadProjectConfig(cwd);
  const cfg = cfgResult.ok ? cfgResult.value : null;
  const warnings: string[] = [];
  const sourceFiles: string[] = [];
  const knowledgeEntries: IKnowledgeEntry[] = [];
  const templates: ITemplateDefinition[] = [];
  const pipelines: IPipelineDefinition[] = [];
  // The file each LOCAL template / pipeline came from, so their sources carry a
  // `file` like knowledge and pack entries do (the contributions inventory and
  // the unregistered-export check attribute ids by file).
  const localTemplateFiles = new Map<string, string>();
  const localPipelineFiles = new Map<string, string>();

  if (cfg) {
    const tsLoader = new TypeScriptKnowledgeLoader({ importContext });
    const mdLoader = new MarkdownKnowledgeLoader();

    const collectFile = async (relPath: string, kindHint: LoaderAssetKind): Promise<void> => {
      const full = nodePath.join(cfg.sharkcraftDir, relPath);
      if (!existsSync(full)) {
        // A default slot file (`rules.ts`, `docs/overview.md`, …) is optional.
        if (OPTIONAL_DEFAULT_KNOWLEDGE_FILES.has(relPath.replace(/^\.\//, ''))) return;
        // The config NAMES this file; loading nothing from it is a fact a
        // corpus verdict must see (it used to vanish: no diagnostic, no warning).
        recordDiagnostic(ctx, {
          filePath: full,
          kind: kindHint,
          origin: 'local-config',
          elapsedMs: 0,
          status: 'missing',
          count: 0,
          warningCount: 0,
          errorMessage: `declared in ${kindHint === 'rules' ? 'ruleFiles' : kindHint === 'paths' ? 'pathFiles' : `${kindHint}Files`} but the file does not exist`,
          deduped: false,
          largeFile: false,
          slow: false,
          suggestedNextCommand: suggestNextCommand(kindHint),
        });
        return;
      }
      sourceFiles.push(full);
      if (tsLoader.canLoad(full)) {
        const tracked = await loadAssetTracked(ctx, full, kindHint, 'local-config', undefined, async () => {
          const r = await tsLoader.load(full);
          knowledgeEntries.push(...r.entries);
          warnings.push(...r.warnings);
          return { count: r.entries.length, warnings: r.warnings, ...(r.rejected ? { rejected: r.rejected } : {}) };
        });
        if (tracked.skipped) warnings.push(...tracked.warnings);
      } else if (mdLoader.canLoad(full)) {
        const tracked = await loadAssetTracked(ctx, full, kindHint, 'local-config', undefined, async () => {
          const r = await mdLoader.load(full);
          knowledgeEntries.push(...r.entries);
          warnings.push(...r.warnings);
          return { count: r.entries.length, warnings: r.warnings, ...(r.rejected ? { rejected: r.rejected } : {}) };
        });
        if (tracked.skipped) warnings.push(...tracked.warnings);
      }
    };

    const fileSets: Array<{ kind: LoaderAssetKind; files: readonly string[] }> = [
      { kind: 'knowledge', files: cfg.config.knowledgeFiles ?? [] },
      { kind: 'rules', files: cfg.config.ruleFiles ?? [] },
      { kind: 'paths', files: cfg.config.pathFiles ?? [] },
      { kind: 'docs', files: cfg.config.docsFiles ?? [] },
    ];
    const seen = new Set<string>();
    for (const { kind, files } of fileSets) {
      for (const f of files) {
        if (seen.has(f)) continue;
        seen.add(f);
        await collectFile(f, kind);
      }
    }

    for (const f of cfg.config.templateFiles ?? []) {
      const full = nodePath.join(cfg.sharkcraftDir, f);
      if (!existsSync(full)) continue;
      sourceFiles.push(full);
      const tracked = await loadAssetTracked(ctx, full, 'templates', 'local-config', undefined, async () => {
        const r = await loadTemplatesFromFile(full, { importContext });
        templates.push(...r.templates);
        for (const t of r.templates) if (!localTemplateFiles.has(t.id)) localTemplateFiles.set(t.id, full);
        warnings.push(...r.warnings);
        return { count: r.templates.length, warnings: r.warnings, rejected: r.rejected };
      });
      if (tracked.skipped) warnings.push(...tracked.warnings);
    }

    for (const f of cfg.config.pipelineFiles ?? []) {
      const full = nodePath.join(cfg.sharkcraftDir, f);
      if (!existsSync(full)) continue;
      sourceFiles.push(full);
      const tracked = await loadAssetTracked(ctx, full, 'pipelines', 'local-config', undefined, async () => {
        const r = await loadPipelinesFromFile(full, { importContext });
        pipelines.push(...r.pipelines);
        for (const p of r.pipelines) if (!localPipelineFiles.has(p.id)) localPipelineFiles.set(p.id, full);
        warnings.push(...r.warnings);
        return { count: r.pipelines.length, warnings: r.warnings, rejected: r.rejected };
      });
      if (tracked.skipped) warnings.push(...tracked.warnings);
    }
  } else if (cfgResult.ok === false) {
    warnings.push(cfgResult.error.message);
  }

  const entrySources = new Map<string, ISourceInfo>();
  for (const e of knowledgeEntries) {
    entrySources.set(e.id, { type: 'local', file: e.source?.origin });
  }
  const templateSources = new Map<string, ISourceInfo>();
  for (const t of templates) {
    const file = localTemplateFiles.get(t.id);
    templateSources.set(t.id, { type: 'local', ...(file ? { file } : {}) });
  }
  const pipelineSources = new Map<string, ISourceInfo>();
  for (const p of pipelines) {
    const file = localPipelineFiles.get(p.id);
    pipelineSources.set(p.id, { type: 'local', ...(file ? { file } : {}) });
  }

  const packs = await discoverPacks({
    projectRoot: workspace.projectRoot,
    ...(options.verifyPackSignatures !== undefined
      ? { verifySignatures: options.verifyPackSignatures }
      : {}),
    ...(options.packSecret !== undefined ? { packSecret: options.packSecret } : {}),
  });
  const tsLoader = new TypeScriptKnowledgeLoader({ importContext });
  const mdLoader = new MarkdownKnowledgeLoader();
  for (const pack of packs.validPacks) {
    const manifest = pack.manifest!;
    const c = manifest.contributions;
    const resolved = {
      knowledgeEntries: 0,
      rules: 0,
      pathConventions: 0,
      templates: 0,
      pipelines: 0,
      docs: 0,
      presets: 0,
      scaffoldPatterns: 0,
      policyChecks: 0,
    };
    const loadFile = async (
      rel: string,
      kind: 'knowledge' | 'rules' | 'paths' | 'docs' | 'templates' | 'pipelines',
    ): Promise<void> => {
      const full = nodePath.resolve(pack.packageRoot, rel);
      if (!existsSync(full)) {
        warnings.push(`pack ${pack.packageName}: missing contribution file ${rel}`);
        return;
      }
      sourceFiles.push(full);
      const src: ISourceInfo = {
        type: 'pack',
        packageName: pack.packageName,
        packageVersion: pack.packageVersion,
        file: full,
      };
      if (kind === 'templates') {
        const tracked = await loadAssetTracked(ctx, full, 'templates', 'pack-manifest', pack.packageName, async () => {
          const r = await loadTemplatesFromFile(full, { importContext });
          for (const t of r.templates) {
            if (templateSources.has(t.id)) {
              warnings.push(
                `pack ${pack.packageName}: template "${t.id}" already provided locally — pack version skipped`,
              );
              continue;
            }
            templates.push(t);
            templateSources.set(t.id, src);
            resolved.templates += 1;
          }
          warnings.push(...r.warnings);
          return { count: r.templates.length, warnings: r.warnings, rejected: r.rejected };
        });
        if (tracked.skipped) warnings.push(...tracked.warnings);
      } else if (kind === 'pipelines') {
        const tracked = await loadAssetTracked(ctx, full, 'pipelines', 'pack-manifest', pack.packageName, async () => {
          const r = await loadPipelinesFromFile(full, { importContext });
          for (const p of r.pipelines) {
            if (pipelineSources.has(p.id)) {
              warnings.push(
                `pack ${pack.packageName}: pipeline "${p.id}" already provided locally — pack version skipped`,
              );
              continue;
            }
            pipelines.push(p);
            pipelineSources.set(p.id, src);
            resolved.pipelines += 1;
          }
          warnings.push(...r.warnings);
          return { count: r.pipelines.length, warnings: r.warnings, rejected: r.rejected };
        });
        if (tracked.skipped) warnings.push(...tracked.warnings);
      } else {
        const loader = tsLoader.canLoad(full) ? tsLoader : mdLoader.canLoad(full) ? mdLoader : null;
        if (!loader) {
          warnings.push(`pack ${pack.packageName}: unsupported contribution file ${rel}`);
          return;
        }
        const tracked = await loadAssetTracked(ctx, full, kind, 'pack-manifest', pack.packageName, async () => {
          const r = await loader.load(full);
          for (const entry of r.entries) {
            if (entrySources.has(entry.id)) {
              warnings.push(
                `pack ${pack.packageName}: knowledge id "${entry.id}" already provided locally — pack version skipped`,
              );
              continue;
            }
            knowledgeEntries.push(entry);
            entrySources.set(entry.id, src);
            const t = String(entry.type);
            if (t === 'rule') resolved.rules += 1;
            else if (t === 'path') resolved.pathConventions += 1;
            else resolved.knowledgeEntries += 1;
          }
          if (kind === 'docs') resolved.docs += 1;
          warnings.push(...r.warnings);
          return { count: r.entries.length, warnings: r.warnings, ...(r.rejected ? { rejected: r.rejected } : {}) };
        });
        if (tracked.skipped) warnings.push(...tracked.warnings);
      }
    };

    for (const rel of c.knowledgeFiles ?? []) await loadFile(rel, 'knowledge');
    for (const rel of c.ruleFiles ?? []) await loadFile(rel, 'rules');
    const loadedPathRels = new Set<string>();
    for (const rel of c.pathFiles ?? []) {
      loadedPathRels.add(rel);
      await loadFile(rel, 'paths');
    }
    // `pathConventionFiles` is a manifest slot distinct from `pathFiles` (see the
    // plugin-api comment "separate from pathFiles"), but it still feeds the path
    // domain. Previously NO loader consumed it, so a pack shipping conventions
    // here loaded nothing. Load it through the same path loader, skipping any rel
    // already handled by `pathFiles` so a file listed in both slots doesn't
    // double-load (entry ids are also deduped by `loadFile`).
    for (const rel of c.pathConventionFiles ?? []) {
      if (loadedPathRels.has(rel)) continue;
      loadedPathRels.add(rel);
      await loadFile(rel, 'paths');
    }
    for (const rel of c.docsFiles ?? []) await loadFile(rel, 'docs');
    for (const rel of c.templateFiles ?? []) await loadFile(rel, 'templates');
    for (const rel of c.pipelineFiles ?? []) await loadFile(rel, 'pipelines');
    pack.resolvedCounts = resolved;
  }
  for (const invalid of packs.invalidPacks) {
    warnings.push(
      `pack ${invalid.packageName}@${invalid.packageVersion}: ${
        invalid.loadError ??
        (invalid.validationIssues.map((i) => `${i.field}: ${i.message}`).join('; ') || 'invalid manifest')
      }`,
    );
  }

  const validation = validateKnowledgeEntries(knowledgeEntries);
  const cleanEntries = validation.uniqueEntries;
  const index = new KnowledgeIndex(cleanEntries);
  const ruleService = new RuleService(cleanEntries);
  const pathService = new PathService(cleanEntries);
  const templateRegistry = new TemplateRegistry(templates);
  const pipelineRegistry = new PipelineRegistry(pipelines);

  const presetRegistry = new PresetRegistry([...BUILTIN_PRESETS]);
  const presetSources = new Map<string, ISourceInfo>();
  for (const builtin of BUILTIN_PRESETS) {
    presetSources.set(builtin.id, { type: 'local', file: 'builtin' });
  }
  for (const pack of packs.validPacks) {
    const c = pack.manifest!.contributions as { presetFiles?: readonly string[] };
    for (const rel of c.presetFiles ?? []) {
      const full = nodePath.resolve(pack.packageRoot, rel);
      if (!existsSync(full)) {
        warnings.push(`pack ${pack.packageName}: missing preset file ${rel}`);
        continue;
      }
      const tracked = await loadAssetTracked(ctx, full, 'presets', 'pack-manifest', pack.packageName, async () => {
        const r = await loadPresetsFromFile(full, { importContext });
        warnings.push(...r.warnings);
        for (const preset of r.presets) {
          if (presetRegistry.has(preset.id)) {
            warnings.push(
              `pack ${pack.packageName}: preset "${preset.id}" already provided — pack version skipped`,
            );
            continue;
          }
          presetRegistry.add(preset);
          presetSources.set(preset.id, {
            type: 'pack',
            packageName: pack.packageName,
            packageVersion: pack.packageVersion,
            file: full,
          });
          if (pack.resolvedCounts) pack.resolvedCounts.presets += 1;
        }
        return { count: r.presets.length, warnings: r.warnings, rejected: r.rejected };
      });
      if (tracked.skipped) warnings.push(...tracked.warnings);
    }
  }
  type CfgWithPresets = ISharkCraftConfig & {
    presetFiles?: readonly string[];
    boundaryFiles?: readonly string[];
    contextTestFiles?: readonly string[];
    agentTestFiles?: readonly string[];
  };
  const cfgExt = cfg?.config as CfgWithPresets | undefined;
  const localPresetFiles = cfgExt?.presetFiles ?? [];
  for (const rel of localPresetFiles) {
    if (!cfg) continue;
    const full = nodePath.join(cfg.sharkcraftDir, rel);
    if (!existsSync(full)) continue;
    const tracked = await loadAssetTracked(ctx, full, 'presets', 'local-config', undefined, async () => {
      const r = await loadPresetsFromFile(full, { importContext });
      warnings.push(...r.warnings);
      for (const preset of r.presets) {
        presetRegistry.add(preset);
        presetSources.set(preset.id, { type: 'local', file: full });
      }
      return { count: r.presets.length, warnings: r.warnings, rejected: r.rejected };
    });
    if (tracked.skipped) warnings.push(...tracked.warnings);
  }

  const boundaryRegistry = new BoundaryRegistry();
  const boundarySources = new Map<string, ISourceInfo>();
  // Round 11: every configured-but-unevaluable boundary rule / file, structured
  // so each boundary surface reports it as an ERRORED rule (never a warning
  // string nobody renders).
  const boundaryLoadIssues: IBoundaryLoadIssue[] = [];
  for (const pack of packs.validPacks) {
    const c = pack.manifest!.contributions as { boundaryFiles?: readonly string[] };
    for (const rel of c.boundaryFiles ?? []) {
      const full = nodePath.resolve(pack.packageRoot, rel);
      if (!existsSync(full)) {
        warnings.push(`pack ${pack.packageName}: missing boundary file ${rel}`);
        boundaryLoadIssues.push({
          file: boundaryFileLabel(workspace.projectRoot, full),
          kind: 'missing-file',
          origin: 'pack',
          packageName: pack.packageName,
          issues: [`pack ${pack.packageName} declares boundary file ${rel}, which does not exist`],
        });
        continue;
      }
      const tracked = await loadAssetTracked(ctx, full, 'boundaries', 'pack-manifest', pack.packageName, async () => {
        // Round 13 (lane B): the pack's name is stamped on each expectEmpty
        // marker of its rules — a pack marker that went live is INFO, never a
        // failure for the consumer, who cannot edit it.
        const r = await loadBoundaryRulesFromFile(full, { importContext, packageName: pack.packageName });
        warnings.push(...r.warnings);
        boundaryLoadIssues.push(...boundaryLoadIssuesFromFile(r, workspace.projectRoot, 'pack', pack.packageName));
        for (const rule of r.rules) {
          if (boundaryRegistry.has(rule.id)) {
            warnings.push(
              `pack ${pack.packageName}: boundary "${rule.id}" already provided — pack version skipped`,
            );
            continue;
          }
          boundaryRegistry.add(rule);
          boundarySources.set(rule.id, {
            type: 'pack',
            packageName: pack.packageName,
            packageVersion: pack.packageVersion,
            file: full,
          });
        }
        return { count: r.rules.length, warnings: r.warnings, rejected: boundaryRejections(full, r.invalid) };
      });
      if (tracked.skipped) {
        warnings.push(...tracked.warnings);
        boundaryLoadIssues.push({
          file: boundaryFileLabel(workspace.projectRoot, full),
          kind: 'load-error',
          origin: 'pack',
          packageName: pack.packageName,
          issues: tracked.warnings.length > 0 ? tracked.warnings : ['the rule file failed to load (cached)'],
        });
      }
    }
  }
  // Local rule files, through THE classification the configuration status
  // reads too — a listed-but-missing file and an unlisted
  // sharkcraft/boundaries.ts are reported identically everywhere (round 11,
  // L-1). The unlisted default is reported, never auto-loaded: loading it
  // silently would start enforcing rules nobody opted into.
  const localBoundaryFiles = cfg
    ? classifyLocalBoundaryFiles(cfg.sharkcraftDir, cfgExt?.boundaryFiles ?? [])
    : { listed: [] as { rel: string; abs: string; exists: boolean }[] };
  for (const listed of localBoundaryFiles.listed) {
    const full = listed.abs;
    if (!listed.exists) {
      warnings.push(
        `boundaryFiles lists "${listed.rel}" but ${full} does not exist — no boundary rules load from it`,
      );
      boundaryLoadIssues.push({
        file: boundaryFileLabel(workspace.projectRoot, full),
        kind: 'missing-file',
        origin: 'local',
        issues: [`boundaryFiles lists "${listed.rel}", but the file does not exist`],
      });
      continue;
    }
    const tracked = await loadAssetTracked(ctx, full, 'boundaries', 'local-config', undefined, async () => {
      const r = await loadBoundaryRulesFromFile(full, { importContext });
      warnings.push(...r.warnings);
      boundaryLoadIssues.push(...boundaryLoadIssuesFromFile(r, workspace.projectRoot, 'local'));
      for (const rule of r.rules) {
        boundaryRegistry.add(rule);
        boundarySources.set(rule.id, { type: 'local', file: full });
      }
      return { count: r.rules.length, warnings: r.warnings, rejected: boundaryRejections(full, r.invalid) };
    });
    if (tracked.skipped) {
      warnings.push(...tracked.warnings);
      boundaryLoadIssues.push({
        file: boundaryFileLabel(workspace.projectRoot, full),
        kind: 'load-error',
        origin: 'local',
        issues: tracked.warnings.length > 0 ? tracked.warnings : ['the rule file failed to load (cached)'],
      });
    }
  }
  if (localBoundaryFiles.unlistedDefault) {
    warnings.push(
      `${boundaryFileLabel(workspace.projectRoot, localBoundaryFiles.unlistedDefault)} exists but is not listed in boundaryFiles — its rules are NOT loaded (add \`boundaryFiles: ['boundaries.ts']\` to sharkcraft.config.ts)`,
    );
  }

  const inspection: ISharkcraftInspection = {
    projectRoot: workspace.projectRoot,
    workspace,
    hasSharkcraftFolder: workspace.hasSharkcraftFolder,
    sharkcraftDir: cfg?.sharkcraftDir ?? workspace.sharkcraftPath ?? null,
    config: cfg?.config ?? null,
    configFile: cfg?.configFile ?? null,
    ...(cfgResult.ok ? {} : describeConfigLoadError(cfgResult.error)),
    knowledgeEntries: cleanEntries,
    templates,
    pipelines,
    warnings,
    sourceFiles,
    validationIssues: validation.issues,
    packs,
    entrySources,
    templateSources,
    pipelineSources,
    presetRegistry,
    presetSources,
    boundaryRegistry,
    boundarySources,
    boundaryLoadIssues,
    index,
    ruleService,
    pathService,
    templateRegistry,
    pipelineRegistry,
    loaderDiagnostics: diagnostics,
    packAssetFreshness: compiledPackFreshness(packs),
    inspectionElapsedMs: Date.now() - inspectStart,
    cacheEnabled: cache.enabled,
    cacheDir: cache.dir,
  };
  // Warm the pack search-tuning cache (best-effort; existsSync-gated + cached
  // per projectRoot) so the synchronous buildTaskPacket → rankAll path can read
  // listSearchTuning and apply pack boostIds — the same tuning `shrk search` uses.
  try {
    await loadSearchTuning(inspection);
  } catch {
    /* tuning is best-effort */
  }
  return inspection;
}

/**
 * Freshness of every valid pack serving compiled contributions — the one
 * authority, called only where something compiled can go stale (TS-source packs
 * are skipped without hashing). Never throws: a pack whose files cannot be read
 * simply reports what it could.
 */
function compiledPackFreshness(packs: IPackDiscoveryResult): readonly IPackAssetFreshness[] {
  const out: IPackAssetFreshness[] = [];
  for (const pack of packs.validPacks ?? []) {
    if (!packHasCompiledContributions(pack.manifest)) continue;
    try {
      out.push(detectPackAssetFreshness(pack));
    } catch {
      /* best-effort */
    }
  }
  return out;
}

/**
 * Summarise a config LOAD failure for the inspection. Only CONFIG_INVALID is a
 * failure of a config file that exists; a missing sharkcraft/ folder has its
 * own doctor check and is not reported here.
 */
function describeConfigLoadError(error: AppError): Pick<ISharkcraftInspection, 'configLoadError'> {
  if (error.code !== ERROR_CODES.CONFIG_INVALID) return {};
  const details = error.details ?? {};
  const fullPath = details['fullPath'];
  const issues: string[] = [];
  const rawIssues = details['issues'];
  if (Array.isArray(rawIssues)) {
    for (const raw of rawIssues as readonly unknown[]) {
      const iss = (raw ?? {}) as { path?: readonly PropertyKey[]; message?: unknown };
      const at = (iss.path ?? []).map(String).join('.') || '<root>';
      issues.push(`${at}: ${typeof iss.message === 'string' ? iss.message : 'invalid value'}`);
    }
  }
  // An import failure (e.g. a syntax error) carries no schema issues; its
  // cause is the build/evaluation error.
  const cause = (error as { cause?: unknown }).cause;
  if (issues.length === 0 && cause instanceof Error) {
    issues.push((cause.message.split('\n')[0] ?? cause.message).trim());
  }
  return {
    configLoadError: {
      file: typeof fullPath === 'string' ? fullPath : null,
      message: error.message,
      issues,
    },
  };
}

/** Inputs `runDoctor` cannot compute from this layer. */
export interface IRunDoctorOptions {
  /**
   * Working-tree divergence of the graph index, from `@shrkcrft/graph`'s
   * `detectGraphFreshness`. Callers above the graph layer (cli, mcp-server)
   * pass it so the code-intelligence checks report a divergence-checked
   * verdict; without it those checks say "not verified" rather than guessing
   * freshness from a timestamp.
   */
  graphDivergence?: IGraphDivergence;
}

export function runDoctor(
  inspection: ISharkcraftInspection,
  options: IRunDoctorOptions = {},
): IDoctorResult {
  const checks: IDoctorCheck[] = [];

  if (!inspection.workspace.hasPackageJson) {
    checks.push({
      id: 'package-json',
      title: 'package.json present',
      severity: DoctorSeverity.Warning,
      message: 'No package.json detected — this may not be a Node-compatible project.',
      fix: 'Run "bun init" or create a package.json.',
    });
  } else {
    checks.push({
      id: 'package-json',
      title: 'package.json present',
      severity: DoctorSeverity.Ok,
      message: `${inspection.workspace.packageName ?? '(unnamed)'} @ ${inspection.workspace.packageVersion ?? '0.0.0'}`,
    });
  }

  if (!inspection.hasSharkcraftFolder) {
    checks.push({
      id: 'sharkcraft-folder',
      title: 'sharkcraft/ folder',
      severity: DoctorSeverity.Error,
      message: 'No sharkcraft/ folder found.',
      fix: 'Run `shrk init` to create one.',
    });
  } else {
    checks.push({
      id: 'sharkcraft-folder',
      title: 'sharkcraft/ folder',
      severity: DoctorSeverity.Ok,
      message: `Found at ${inspection.sharkcraftDir}`,
    });
  }

  if (inspection.configLoadError) {
    // A config file EXISTS but was rejected. The loader then drops the WHOLE
    // config — its knowledge/rule/template file lists and every config-declared
    // plane — so this is an error, and it is never also "no config file".
    const failure = inspection.configLoadError;
    const where = failure.file ?? 'sharkcraft/sharkcraft.config.ts';
    const detail = failure.issues.length > 0 ? failure.issues.join('; ') : failure.message;
    checks.push({
      id: 'config',
      title: 'sharkcraft.config.ts',
      severity: DoctorSeverity.Error,
      category: 'config-invalid',
      code: 'config-invalid',
      message: `Invalid config ${where} — NOT loaded, every config-declared setting and plane is dropped: ${detail}`,
      fix: `Fix the listed fields in ${where} (every key is validated against SharkCraftConfigSchema), then re-run \`shrk doctor\`.`,
      whyThisMatters:
        'An invalid config is discarded whole: its knowledge/rule/template file lists and every gate plane (wiring rules, registries, policy rules, baselines, …) silently fall back to nothing.',
    });
  } else if (!inspection.configFile) {
    checks.push({
      id: 'config',
      title: 'sharkcraft.config.ts',
      severity: DoctorSeverity.Warning,
      message: 'No config file detected — using defaults.',
      fix: 'Create sharkcraft/sharkcraft.config.ts to customize knowledge file paths.',
    });
  } else {
    checks.push({
      id: 'config',
      title: 'sharkcraft.config.ts',
      severity: DoctorSeverity.Ok,
      message: `Loaded from ${inspection.configFile}`,
    });
  }

  // A replacing `registryLifecycle.skipDirs` that drops node_modules / dist / …
  // makes the lifecycle scan read vendored and generated code. The one
  // skip-dir authority decides; this only reports what it dropped.
  const lifecycleSkip = inspection.config?.registryLifecycle;
  if (lifecycleSkip?.skipDirs !== undefined) {
    const { droppedDefaults } = resolveRegistryLifecycleSkipDirs(lifecycleSkip);
    if (droppedDefaults.length > 0) {
      checks.push({
        id: 'registry-lifecycle-skip-dirs',
        title: 'registryLifecycle.skipDirs',
        severity: DoctorSeverity.Warning,
        message: registryLifecycleSkipDirsWarning(droppedDefaults),
        fix: `Use \`registryLifecycle.skipDirsAdd\` (extends the defaults), or add ${droppedDefaults.join(', ')} back to \`skipDirs\`.`,
      });
    }
  }

  if (inspection.knowledgeEntries.length === 0) {
    checks.push({
      id: 'knowledge',
      title: 'knowledge entries',
      severity: DoctorSeverity.Warning,
      message: 'No knowledge entries loaded.',
      fix: 'Add entries to sharkcraft/knowledge.ts using defineKnowledgeEntry()',
    });
  } else {
    checks.push({
      id: 'knowledge',
      title: 'knowledge entries',
      severity: DoctorSeverity.Ok,
      message: `${inspection.knowledgeEntries.length} entries loaded.`,
    });
  }

  if (inspection.templates.length === 0) {
    checks.push({
      id: 'templates',
      title: 'templates',
      severity: DoctorSeverity.Info,
      message: 'No templates registered.',
      fix: 'Define templates via defineTemplate() in sharkcraft/templates.ts',
    });
  } else {
    checks.push({
      id: 'templates',
      title: 'templates',
      severity: DoctorSeverity.Ok,
      message: `${inspection.templates.length} templates registered.`,
    });
  }

  if (inspection.packs.discoveredPacks.length > 0) {
    const v = inspection.packs.validPacks.length;
    const i = inspection.packs.invalidPacks.length;
    checks.push({
      id: 'packs',
      title: 'packs',
      severity: i === 0 ? DoctorSeverity.Ok : DoctorSeverity.Warning,
      message:
        i === 0
          ? `${v} pack(s) discovered.`
          : `${v} valid, ${i} invalid pack(s). See \`shrk packs doctor\`.`,
    });
  } else {
    // Zero packs discovered. The costly silent-failure case: the repo SHIPS
    // a pack (e.g. tools/sharkcraft-pack) but it is not linked into
    // node_modules, where discovery scans. When that happens every
    // contribution — templates, boundaries, knowledge — goes dark and doctor
    // otherwise collapses to "No templates registered / no boundary rules"
    // with no hint about the real cause. Detect it and make it actionable.
    const discoveredNames = new Set(
      inspection.packs.discoveredPacks.map((p) => p.packageName),
    );
    const unlinked = findUnlinkedInRepoPacks(inspection.projectRoot, discoveredNames);
    const first = unlinked[0];
    if (first) {
      const list = unlinked.map((u) => `${u.packageName} (${u.relPath})`).join(', ');
      const up = first.packageName.startsWith('@') ? '../../' : '../';
      checks.push({
        id: 'packs',
        title: 'packs',
        severity: DoctorSeverity.Warning,
        message: `In-repo pack(s) present but NOT discovered: ${list}. shrk discovers packs by scanning node_modules, so an unlinked in-repo pack loads nothing — templates, boundary rules, and knowledge all go dark even though the assets exist on disk.`,
        fix: `Link it into node_modules so discovery sees it: \`mkdir -p node_modules/$(dirname ${first.packageName}) && ln -sfn ${up}${first.relPath} node_modules/${first.packageName}\` — or add a \`"${first.packageName}": "file:${first.relPath}"\` dependency. Then re-run \`shrk packs list\`.`,
      });
    }
  }

  // Compiled pack contributions served from an older build (or with no build
  // record at all). The one freshness authority computed this at inspection;
  // absent for TS-source packs, so a repo without compiled packs sees nothing.
  for (const f of inspection.packAssetFreshness ?? []) {
    if (f.build.state !== 'stale' && f.build.state !== 'unrecorded') continue;
    const said = describePackAssetFreshness(f).build;
    if (!said) continue;
    checks.push({
      id: `pack-compiled-artifacts-${f.packageName}`,
      title: 'Pack compiled artifacts',
      severity: DoctorSeverity.Warning,
      category: 'pack-compiled-artifacts',
      code: f.build.state === 'stale' ? 'compiled-artifacts-stale' : 'compiled-artifacts-unrecorded',
      message: said,
      ...(f.build.rebuildCommand ? { fix: `(cd ${f.packageRoot} && ${f.build.rebuildCommand})` } : {}),
    });
  }

  if (inspection.pipelines.length === 0) {
    checks.push({
      id: 'pipelines',
      title: 'pipelines',
      severity: DoctorSeverity.Info,
      message: 'No pipelines registered.',
      fix: 'Define pipelines via definePipeline() in sharkcraft/pipelines.ts (optional but recommended).',
    });
  } else {
    checks.push({
      id: 'pipelines',
      title: 'pipelines',
      severity: DoctorSeverity.Ok,
      message: `${inspection.pipelines.length} pipelines registered.`,
    });
  }

  // Surface loader timeouts / failures as doctor errors so a
  // broken pack asset is immediately visible instead of swallowed.
  for (const d of inspection.loaderDiagnostics) {
    if (d.status === 'ok') continue;
    const sevByStatus =
      d.status === 'timeout' || d.status === 'failed'
        ? DoctorSeverity.Error
        : DoctorSeverity.Warning;
    checks.push({
      id: `loader-${d.status}-${nodePath.basename(d.filePath)}`,
      title: `Loader ${d.status} (${d.kind})`,
      severity: sevByStatus,
      message: `${d.kind} loader ${d.status} after ${d.elapsedMs}ms: ${d.filePath}${d.errorMessage ? ` — ${d.errorMessage}` : ''}`,
      fix: d.suggestedNextCommand,
    });
  }

  for (const w of inspection.warnings) {
    // The config load failure is already reported above as an error; do not
    // repeat it as a second, weaker "Loader warning".
    if (w === inspection.configLoadError?.message) continue;
    checks.push({
      id: `warning-${checks.length}`,
      title: 'Loader warning',
      severity: DoctorSeverity.Warning,
      message: w,
    });
  }

  for (const v of inspection.validationIssues) {
    checks.push({
      id: `validation-${v.code}-${v.entryId}`,
      title: `Knowledge validation (${v.code})`,
      severity: v.severity === 'error' ? DoctorSeverity.Error : DoctorSeverity.Warning,
      message: v.message,
      fix: v.source ? `Edit ${v.source}` : undefined,
    });
  }

  // Surface profile drift advisory. Warn (advisory) when the
  // configured `surface.profile` no longer matches what the workspace
  // shape suggests today, so the user knows to re-run init or override.
  const cfgSurface = (inspection.config as { surface?: { profile?: string } } | null)?.surface;
  if (cfgSurface?.profile) {
    try {
      const detected = suggestSurfaceProfile(inspection.workspace.profiles);
      if (detected.profile !== cfgSurface.profile) {
        checks.push({
          id: 'surface-profile-drift',
          title: 'Surface profile drift',
          severity: DoctorSeverity.Warning,
          advisory: true,
          message:
            `surface.profile is "${cfgSurface.profile}" but the workspace now looks like "${detected.profile}" (${detected.reason})`,
          fix: `Re-run with: shrk init --surface-profile ${detected.profile} --write`,
          category: 'surface-profile',
        });
      }
    } catch {
      // best-effort
    }
  }

  const hintsEnabled =
    (inspection.config as { actionHintDiagnostics?: boolean } | null)?.actionHintDiagnostics !==
    false;
  if (hintsEnabled) {
    const hintReport = diagnoseActionHints(inspection.knowledgeEntries);
    for (const i of hintReport.issues) {
      checks.push({
        id: `actionhints-${i.code}-${i.entryId}`,
        title: `Action-hint quality (${i.code})`,
        severity: DoctorSeverity.Warning,
        advisory: true,
        message: i.message,
        fix: i.suggestion,
        category: 'action-hint-quality',
        code: i.code,
        recommendedFix: `shrk fix preview --action-hints --target ${i.entryId}`,
        whyThisMatters: actionHintWhyThisMatters(i.code),
      });
    }
  }

  // Code-intelligence package health (graph, rule-graph, api-surface,
  // quality-gates, migrations). Each finding reads a stable on-disk
  // state file under `.sharkcraft/` and stays silent when the user has
  // not opted into the relevant feature.
  for (const c of buildCodeIntelligenceChecks(inspection.projectRoot, {
    ...(options.graphDivergence ? { graphDivergence: options.graphDivergence } : {}),
  })) {
    checks.push(c);
  }

  // Delegate-worker recipe health: surface any recipe that isn't safely
  // delegatable (unbound / missing verification). Silent when the repo hasn't
  // opted into a `delegation` block.
  for (const c of buildDelegateRecipeChecks(inspection.config)) {
    checks.push(c);
  }

  const summary: {
    ok: number;
    info: number;
    warnings: number;
    errors: number;
    advisoryCount: number;
  } = { ok: 0, info: 0, warnings: 0, errors: 0, advisoryCount: 0 };
  for (const c of checks) {
    if (c.severity === DoctorSeverity.Ok) summary.ok += 1;
    else if (c.severity === DoctorSeverity.Info) summary.info += 1;
    else if (c.severity === DoctorSeverity.Warning) summary.warnings += 1;
    else if (c.severity === DoctorSeverity.Error) summary.errors += 1;
    // AdvisoryCount = info-severity OR explicitly marked advisory.
    if (c.severity === DoctorSeverity.Info || c.advisory === true) {
      summary.advisoryCount += 1;
    }
  }

  // A compiled pack build with NO build record was never compared with its
  // source, so the build the pack serves is unverified. The warning check above
  // names it; this record is what keeps `shrk doctor` from reading "Ready ✓"
  // over it (settled NOT VERIFIED, 2, like `packs doctor`). A stale build WAS
  // compared (its finding stays a warning), and a repo with no compiled pack,
  // or only fresh builds, gets no record at all.
  const compiledBuilds = (inspection.packAssetFreshness ?? []).filter((f) => f.build.state !== 'not-compiled');
  const unrecordedBuilds = compiledBuilds
    .filter((f) => f.build.state === 'unrecorded')
    .map((f) => f.packageName)
    .sort();
  const coverage: NonNullable<IDoctorResult['coverage']> =
    unrecordedBuilds.length > 0
      ? [
          {
            unit: 'compiled pack builds',
            expected: compiledBuilds.length,
            examined: compiledBuilds.length - unrecordedBuilds.length,
            unexamined: unrecordedBuilds,
            reason:
              'no build record, so the compiled artifacts they serve were never compared with their source (rebuild the pack to record one)',
          },
        ]
      : [];

  return { passed: summary.errors === 0, checks, summary, ...(coverage.length > 0 ? { coverage } : {}) };
}

function actionHintWhyThisMatters(code: string): string {
  switch (code) {
    case 'missing-hints':
      return 'Without actionHints the agent must guess what to run; high-priority rules cannot drive a deterministic flow.';
    case 'missing-commands-or-mcp':
      return 'A high-priority rule with no commands/mcpTools cannot be acted on automatically.';
    case 'missing-forbidden-actions':
      return 'Rules that ban behaviour need an explicit forbiddenActions list so agents and reviewers know what to avoid.';
    case 'missing-verification':
      return 'Enforceable rules need verificationCommands so `shrk apply --validate` and the agent can check the result.';
    case 'missing-write-policy':
      return 'Write-related rules must declare writePolicy so agents know whether mutation is allowed via MCP/CLI.';
    case 'missing-related-templates':
      return 'Template-related rules without relatedTemplates leave agents guessing which scaffold to use.';
    case 'missing-related-path-conventions':
      return 'Path-related rules without relatedPathConventions leave agents guessing where to write files.';
    default:
      return 'Improving action-hint quality keeps doctor output actionable instead of permanent yellow noise.';
  }
}
