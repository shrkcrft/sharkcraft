import { existsSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  createImportContext,
  DEFAULT_SAFE_IMPORT_TIMEOUT_MS,
  type IImportContext,
} from '@shrkcrft/core';
import { inspectWorkspace, type IWorkspaceSummary } from '@shrkcrft/workspace';
import { type ISharkCraftConfig, loadProjectConfig } from '@shrkcrft/config';
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
import { diagnoseActionHints } from './action-hint-diagnostics.ts';
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

export interface ISharkcraftInspection {
  projectRoot: string;
  workspace: IWorkspaceSummary;
  hasSharkcraftFolder: boolean;
  sharkcraftDir: string | null;
  config: ISharkCraftConfig | null;
  configFile: string | null;
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
  /** Per-loader timing + status diagnostics. */
  loaderDiagnostics: readonly ILoaderDiagnostic[];
  /** Total wall-clock ms spent in inspectSharkcraft. */
  inspectionElapsedMs: number;
  /** Whether the inspector cache was enabled for this run. */
  cacheEnabled: boolean;
  /** Directory where the persistent inspector cache lives. */
  cacheDir: string;
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

async function loadAssetTracked(
  ctx: ILoaderTaskContext,
  filePath: string,
  kind: LoaderAssetKind,
  origin: LoaderOrigin,
  packName: string | undefined,
  performLoad: () => Promise<{ count: number; warnings: string[]; errorMessage?: string }>,
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

  if (cfg) {
    const tsLoader = new TypeScriptKnowledgeLoader({ importContext });
    const mdLoader = new MarkdownKnowledgeLoader();

    const collectFile = async (relPath: string, kindHint: LoaderAssetKind): Promise<void> => {
      const full = nodePath.join(cfg.sharkcraftDir, relPath);
      if (!existsSync(full)) return;
      sourceFiles.push(full);
      if (tsLoader.canLoad(full)) {
        const tracked = await loadAssetTracked(ctx, full, kindHint, 'local-config', undefined, async () => {
          const r = await tsLoader.load(full);
          knowledgeEntries.push(...r.entries);
          warnings.push(...r.warnings);
          return { count: r.entries.length, warnings: r.warnings };
        });
        if (tracked.skipped) warnings.push(...tracked.warnings);
      } else if (mdLoader.canLoad(full)) {
        const tracked = await loadAssetTracked(ctx, full, kindHint, 'local-config', undefined, async () => {
          const r = await mdLoader.load(full);
          knowledgeEntries.push(...r.entries);
          warnings.push(...r.warnings);
          return { count: r.entries.length, warnings: r.warnings };
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
        warnings.push(...r.warnings);
        return { count: r.templates.length, warnings: r.warnings };
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
        warnings.push(...r.warnings);
        return { count: r.pipelines.length, warnings: r.warnings };
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
    templateSources.set(t.id, { type: 'local' });
  }
  const pipelineSources = new Map<string, ISourceInfo>();
  for (const p of pipelines) {
    pipelineSources.set(p.id, { type: 'local' });
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
          return { count: r.templates.length, warnings: r.warnings };
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
          return { count: r.pipelines.length, warnings: r.warnings };
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
          return { count: r.entries.length, warnings: r.warnings };
        });
        if (tracked.skipped) warnings.push(...tracked.warnings);
      }
    };

    for (const rel of c.knowledgeFiles ?? []) await loadFile(rel, 'knowledge');
    for (const rel of c.ruleFiles ?? []) await loadFile(rel, 'rules');
    for (const rel of c.pathFiles ?? []) await loadFile(rel, 'paths');
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
        return { count: r.presets.length, warnings: r.warnings };
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
      return { count: r.presets.length, warnings: r.warnings };
    });
    if (tracked.skipped) warnings.push(...tracked.warnings);
  }

  const boundaryRegistry = new BoundaryRegistry();
  const boundarySources = new Map<string, ISourceInfo>();
  for (const pack of packs.validPacks) {
    const c = pack.manifest!.contributions as { boundaryFiles?: readonly string[] };
    for (const rel of c.boundaryFiles ?? []) {
      const full = nodePath.resolve(pack.packageRoot, rel);
      if (!existsSync(full)) {
        warnings.push(`pack ${pack.packageName}: missing boundary file ${rel}`);
        continue;
      }
      const tracked = await loadAssetTracked(ctx, full, 'boundaries', 'pack-manifest', pack.packageName, async () => {
        const r = await loadBoundaryRulesFromFile(full, { importContext });
        warnings.push(...r.warnings);
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
        return { count: r.rules.length, warnings: r.warnings };
      });
      if (tracked.skipped) warnings.push(...tracked.warnings);
    }
  }
  for (const rel of cfgExt?.boundaryFiles ?? []) {
    if (!cfg) continue;
    const full = nodePath.join(cfg.sharkcraftDir, rel);
    if (!existsSync(full)) continue;
    const tracked = await loadAssetTracked(ctx, full, 'boundaries', 'local-config', undefined, async () => {
      const r = await loadBoundaryRulesFromFile(full, { importContext });
      warnings.push(...r.warnings);
      for (const rule of r.rules) {
        boundaryRegistry.add(rule);
        boundarySources.set(rule.id, { type: 'local', file: full });
      }
      return { count: r.rules.length, warnings: r.warnings };
    });
    if (tracked.skipped) warnings.push(...tracked.warnings);
  }

  return {
    projectRoot: workspace.projectRoot,
    workspace,
    hasSharkcraftFolder: workspace.hasSharkcraftFolder,
    sharkcraftDir: cfg?.sharkcraftDir ?? workspace.sharkcraftPath ?? null,
    config: cfg?.config ?? null,
    configFile: cfg?.configFile ?? null,
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
    index,
    ruleService,
    pathService,
    templateRegistry,
    pipelineRegistry,
    loaderDiagnostics: diagnostics,
    inspectionElapsedMs: Date.now() - inspectStart,
    cacheEnabled: cache.enabled,
    cacheDir: cache.dir,
  };
}

export function runDoctor(inspection: ISharkcraftInspection): IDoctorResult {
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

  if (!inspection.configFile) {
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
        message: i.message,
        fix: i.suggestion,
        category: 'action-hint-quality',
        code: i.code,
        recommendedFix: `shrk fix preview --action-hints --target ${i.entryId}`,
        whyThisMatters: actionHintWhyThisMatters(i.code),
      });
    }
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

  return { passed: summary.errors === 0, checks, summary };
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
