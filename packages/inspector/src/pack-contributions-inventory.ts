/**
 * Generic pack contributions inventory + conflict detector.
 *
 * Reads each pack's manifest, enumerates the contribution slots, and reports:
 *   - one row per (kind, id, source) — the inventory
 *   - one row per detected collision — the conflicts
 *
 * Both outputs are deterministic and read-only.
 *
 * Honesty contract (round 11): an id the inventory could only SCRAPE is never
 * reported as a healthy contribution. A file the module loader cannot import is
 * a load failure — its scraped ids are `validation: 'error'` and the file is an
 * `invalid-contribution` error conflict. A regex id from a kind whose loader
 * returned nothing for that file is a `warning`. Every text/markdown render
 * prints the extraction mode, so a fallback is never invisible.
 *
 * Round 12 (12.1e): EVERY loader-backed slot is a kind and is listed
 * structurally (registration hints, presets, boundaries, scaffold patterns,
 * constructs + facets, search tuning, decisions, policy checks, feedback rules,
 * tests, delegate recipes, framework extractors and the gate planes were
 * scraped by regex, or not listed at all), and an entry its loader REFUSED is
 * in `rejections` — a scraped id matching one is `error` "rejected by the
 * loader", never the `ok` a regex id of an unloaded kind used to get.
 */
import { readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { CONTRIBUTION_FILE_KEYS } from '@shrkcrft/plugin-api';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import {
  collectContributionLoadFailures,
  collectContributionRejections,
  collectRegistryOutcomes,
  formatEntryRejection,
  rejectedEntrySlot,
  type IContributionLoadFailure,
} from './contribution-load-failures.ts';
import { ContributionKind } from './contribution-kind.ts';
import type { IContributionEntryRejection } from './i-contribution-entry-rejection.ts';
import { describePackAssetFreshness, detectPackAssetFreshness } from './pack-asset-freshness.ts';

export { ContributionKind } from './contribution-kind.ts';

export const PACK_CONTRIBUTIONS_INVENTORY_SCHEMA =
  'sharkcraft.pack-contributions-inventory/v1';

export enum ContributionSource {
  Builtin = 'builtin',
  Local = 'local',
  Pack = 'pack',
  Fixture = 'fixture',
}

/**
 * How the inventory derived this entry's id.
 *   - `structural`     — authoritative ids from the loader for this kind.
 *   - `regex-fallback` — id extracted by regex from the raw source file;
 *                        nested `id:` fields may produce false positives, and
 *                        nothing proves the id takes effect (unverified).
 *   - `file-only`      — file exists but no id could be extracted; entry
 *                        represents the file itself, not a contribution id.
 */
export type ExtractionMode = 'structural' | 'regex-fallback' | 'file-only';

export interface IContributionEntry {
  readonly kind: ContributionKind;
  readonly id: string;
  readonly title?: string;
  readonly source: ContributionSource;
  readonly packageName?: string;
  readonly sourceFile?: string;
  readonly validation: 'ok' | 'warning' | 'error';
  readonly validationMessage?: string;
  readonly enabled?: boolean;
  readonly references?: readonly string[];
  /** Extraction provenance; informs conflict severity. */
  readonly extractionMode?: ExtractionMode;
  /** Low when extracted via regex fallback. */
  readonly confidence?: 'high' | 'medium' | 'low';
}

export enum ConflictKind {
  DuplicateIdSameKind = 'duplicate-id-same-kind',
  DuplicateIdDifferentSource = 'duplicate-id-different-source',
  ShadowedLocalConfig = 'shadowed-local-config',
  ShadowedPackConfig = 'shadowed-pack-config',
  InvalidContribution = 'invalid-contribution',
  MissingReferencedId = 'missing-referenced-id',
  StaleSignature = 'stale-signature',
  IncompatibleSchema = 'incompatible-schema',
  MissingLoader = 'missing-loader',
}

export interface IContributionConflict {
  readonly kind: ConflictKind;
  readonly contributionKind: ContributionKind;
  readonly id: string;
  readonly sources: readonly {
    source: ContributionSource;
    packageName?: string;
    sourceFile?: string;
  }[];
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly nextCommand?: string;
}

export interface IPackContributionsInventory {
  readonly schema: typeof PACK_CONTRIBUTIONS_INVENTORY_SCHEMA;
  readonly generatedAt: string;
  readonly projectRoot: string;
  readonly entriesByKind: Readonly<Record<string, readonly IContributionEntry[]>>;
  readonly totals: Readonly<Record<string, number>>;
  readonly entries: readonly IContributionEntry[];
  readonly conflicts: readonly IContributionConflict[];
  readonly packs: readonly {
    name: string;
    version: string;
    root: string;
    signaturePresent: boolean;
  }[];
  /**
   * How every entry's id was derived. `regexFallback` ids are unverified —
   * nothing proved they take effect; `structural` ones came from the loader.
   * `rejected` counts the declared entries a loader refused (round 12).
   */
  readonly extractionTotals: {
    readonly structural: number;
    readonly regexFallback: number;
    readonly fileOnly: number;
    readonly rejected: number;
  };
  /**
   * Every contribution file that failed to load, with the ids the regex
   * scraped from it (which do NOT take effect). Project-relative paths.
   */
  readonly loadFailures: readonly {
    readonly file: string;
    readonly kind: string;
    readonly packageName?: string;
    readonly message: string;
    readonly scrapedIds: readonly string[];
  }[];
  /**
   * Every declared entry a loader REFUSED (round 12, 12.1) — THE rejection
   * channel (`collectContributionRejections`), project-relative. None of them
   * takes effect; a scraped id matching one is `validation: 'error'`.
   */
  readonly rejections: readonly {
    readonly file: string;
    readonly kind: ContributionKind;
    readonly packageName?: string;
    readonly index: number;
    readonly exportName?: string;
    readonly entryId?: string;
    readonly reasons: readonly string[];
    readonly cause: IContributionEntryRejection['cause'];
  }[];
  /**
   * `async` — built by {@link buildPackContributionsInventoryAsync} (loaders
   * consulted); `sync` — the regex-only compatibility wrapper, whose regex ids
   * are marked unverified.
   */
  readonly mode: 'async' | 'sync';
}

interface IContribFileEntry {
  kind: ContributionKind;
  packageName?: string;
  packageRoot?: string;
  files: readonly string[];
  source: ContributionSource;
}

/**
 * THE contribution kind → manifest slot table. A `Record` over the enum: a kind
 * without a slot is a compile error, and the r76 census holds every
 * loader-backed `CONTRIBUTION_FILE_KEYS` slot to exactly one kind here.
 */
export const CONTRIBUTION_KIND_SLOT: Readonly<Record<ContributionKind, string>> = Object.freeze({
  [ContributionKind.Knowledge]: 'knowledgeFiles',
  [ContributionKind.Rule]: 'ruleFiles',
  [ContributionKind.Path]: 'pathFiles',
  [ContributionKind.PathConvention]: 'pathConventionFiles',
  [ContributionKind.Template]: 'templateFiles',
  [ContributionKind.Pipeline]: 'pipelineFiles',
  [ContributionKind.Preset]: 'presetFiles',
  [ContributionKind.Boundary]: 'boundaryFiles',
  [ContributionKind.ScaffoldPattern]: 'scaffoldPatternFiles',
  [ContributionKind.Policy]: 'policyCheckFiles',
  [ContributionKind.Construct]: 'constructFiles',
  [ContributionKind.ConstructFacet]: 'constructFacetFiles',
  [ContributionKind.Playbook]: 'playbookFiles',
  [ContributionKind.SearchTuning]: 'searchTuningFiles',
  [ContributionKind.FeedbackRule]: 'feedbackRuleFiles',
  [ContributionKind.Decision]: 'decisionFiles',
  [ContributionKind.ContractTemplate]: 'contractTemplateFiles',
  [ContributionKind.MigrationProfile]: 'migrationProfileFiles',
  [ContributionKind.ContextTest]: 'contextTestFiles',
  [ContributionKind.AgentTest]: 'agentTestFiles',
  [ContributionKind.Helper]: 'helperFiles',
  [ContributionKind.TaskRoutingHint]: 'taskRoutingHintFiles',
  [ContributionKind.RegistrationHint]: 'registrationHintFiles',
  [ContributionKind.Convention]: 'conventionFiles',
  [ContributionKind.Docs]: 'docsFiles',
  [ContributionKind.DelegateRecipe]: 'delegateRecipeFiles',
  [ContributionKind.FrameworkExtractor]: 'frameworkExtractorFiles',
  [ContributionKind.WiringRule]: 'wiringRuleFiles',
  [ContributionKind.Registry]: 'registryFiles',
  [ContributionKind.RegistrationIdiom]: 'registrationGraphFiles',
  [ContributionKind.PolicyRule]: 'policyRuleFiles',
  [ContributionKind.ReusePrimitive]: 'reusePrimitiveFiles',
  [ContributionKind.Baseline]: 'baselineFiles',
  [ContributionKind.GeneratedArtifact]: 'generatedArtifactFiles',
  [ContributionKind.DocReference]: 'docReferenceFiles',
});

/** The contribution kind a manifest slot's files are loaded as, or `undefined` for a slot no loader reads. */
export function contributionKindForSlot(slot: string): ContributionKind | undefined {
  for (const [kind, s] of Object.entries(CONTRIBUTION_KIND_SLOT)) if (s === slot) return kind as ContributionKind;
  return undefined;
}

/**
 * A slot whose files are loaded under a DIFFERENT kind: `pathConventionFiles`
 * feed the path loader, `docsFiles` the markdown knowledge loader. A file the
 * other kind handled structurally is handled for this slot too.
 */
const ALSO_HANDLED_BY: Partial<Record<ContributionKind, readonly ContributionKind[]>> = {
  [ContributionKind.PathConvention]: [ContributionKind.Path],
  [ContributionKind.Docs]: [ContributionKind.Knowledge],
};

function safeRead(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Lightweight static extractor — looks for `id: '...'` and `title: '...'`
 * occurrences inside a contribution file. Used ONLY where no loader answered
 * for a file; its ids are tagged `regex-fallback` and never reported as a
 * verified contribution.
 */
function extractIdsFromFile(content: string): { id: string; title?: string }[] {
  const entries: { id: string; title?: string }[] = [];
  const idRe = /\bid\s*:\s*['"]([A-Za-z_][\w.-]*)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = idRe.exec(content)) !== null) {
    const id = match[1]!;
    // Look ahead a bit for a title within the next ~200 chars.
    const lookahead = content.slice(match.index, match.index + 400);
    const titleMatch = /\btitle\s*:\s*['"]([^'"]+)['"]/.exec(lookahead);
    const entry: { id: string; title?: string } = { id };
    if (titleMatch) entry.title = titleMatch[1] ?? undefined;
    entries.push(entry);
  }
  return entries;
}

function buildContribFileEntries(inspection: ISharkcraftInspection): IContribFileEntry[] {
  const out: IContribFileEntry[] = [];

  // Local contributions inferred from sharkcraft.config + conventional file
  // names. (The engine doesn't have a single canonical list; we use the same
  // file-name conventions the loaders accept.)
  const dir = inspection.sharkcraftDir;
  if (dir) {
    const localConventions: { kind: ContributionKind; relCandidates: string[] }[] = [
      { kind: ContributionKind.Knowledge, relCandidates: ['knowledge.ts'] },
      { kind: ContributionKind.Rule, relCandidates: ['rules.ts'] },
      { kind: ContributionKind.Path, relCandidates: ['paths.ts'] },
      { kind: ContributionKind.PathConvention, relCandidates: ['path-conventions.ts'] },
      { kind: ContributionKind.Template, relCandidates: ['templates.ts'] },
      { kind: ContributionKind.Pipeline, relCandidates: ['pipelines.ts'] },
      { kind: ContributionKind.ScaffoldPattern, relCandidates: ['scaffold-patterns.ts'] },
      { kind: ContributionKind.Policy, relCandidates: ['policies.ts'] },
      { kind: ContributionKind.Construct, relCandidates: ['constructs.ts'] },
      { kind: ContributionKind.ConstructFacet, relCandidates: ['construct-facets.ts'] },
      { kind: ContributionKind.Playbook, relCandidates: ['playbooks.ts'] },
      { kind: ContributionKind.SearchTuning, relCandidates: ['search-tuning.ts'] },
      { kind: ContributionKind.FeedbackRule, relCandidates: ['feedback-rules.ts'] },
      { kind: ContributionKind.Decision, relCandidates: ['decisions.ts'] },
      { kind: ContributionKind.ContextTest, relCandidates: ['context-tests.ts'] },
      { kind: ContributionKind.AgentTest, relCandidates: ['agent-tests.ts'] },
      { kind: ContributionKind.ContractTemplate, relCandidates: ['contract-templates.ts'] },
      { kind: ContributionKind.MigrationProfile, relCandidates: ['migration-profiles.ts'] },
      { kind: ContributionKind.Helper, relCandidates: ['helpers.ts'] },
      { kind: ContributionKind.TaskRoutingHint, relCandidates: ['task-routing-hints.ts'] },
      { kind: ContributionKind.RegistrationHint, relCandidates: ['registration-hints.ts'] },
      { kind: ContributionKind.Convention, relCandidates: ['conventions.ts'] },
    ];
    for (const c of localConventions) {
      const files = c.relCandidates
        .map((rel) => nodePath.join(dir, rel))
        .filter((abs) => safeRead(abs) !== null);
      if (files.length > 0) {
        out.push({ kind: c.kind, files, source: ContributionSource.Local });
      }
    }
  }

  // Pack contributions from manifests.
  for (const pack of inspection.packs.validPacks ?? []) {
    const contributions = (pack.manifest?.contributions ?? {}) as Record<string, readonly string[] | undefined>;
    for (const kind of Object.values(ContributionKind)) {
      const slot = CONTRIBUTION_KIND_SLOT[kind];
      const rels = contributions[slot];
      if (!rels || rels.length === 0) continue;
      const abs = rels.map((rel) => nodePath.resolve(pack.packageRoot, rel)).filter((f) => safeRead(f) !== null);
      out.push({
        kind,
        packageName: pack.packageName,
        packageRoot: pack.packageRoot,
        files: abs,
        source: ContributionSource.Pack,
      });
    }
  }
  return out;
}

/**
 * Structural id map keyed by (kind, sourceFile-rel-path).
 *
 * Each entry is one authoritative id loaded via the dedicated registry for
 * its kind. The presence of any structural entries for a `(kind, file)` pair
 * suppresses the regex fallback for that pair, eliminating nested-step-id
 * false positives.
 */
interface IStructuralEntry {
  readonly id: string;
  readonly title?: string;
  readonly source: ContributionSource;
  readonly packageName?: string;
}

interface IStructuralMap {
  /** ContributionKind → relativeSourceFile → IStructuralEntry[] */
  readonly byKindAndFile: ReadonlyMap<string, ReadonlyMap<string, readonly IStructuralEntry[]>>;
  /** ContributionKind → set of relativeSourceFiles handled structurally. */
  readonly structuralFiles: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * `(kind, id, packageName)` triples already emitted by the
   * structural loader. The regex fallback skips entries that match a
   * triple so the same logical pack contribution doesn't appear twice when
   * the pack is reachable from two paths (e.g. the dev source AND the
   * installed copy under `node_modules/...`).
   */
  readonly structuralIds: ReadonlyMap<string, ReadonlySet<string>>;
  /** Load failures the registry loaders reported while building this map. */
  readonly loadFailures: readonly IContributionLoadFailure[];
  /** Entries the registry loaders refused while building this map (round 12). */
  readonly rejections: readonly IContributionEntryRejection[];
}

/**
 * Where a registry `sourceFile` lives, as a project-relative path. Registries
 * report a PACK-relative path for pack entries and a PROJECT-relative one for
 * local entries; resolving either against `process.cwd()` (as this used to)
 * made the inventory cwd-dependent and broke nested-id suppression.
 */
function sourceFileResolver(inspection: ISharkcraftInspection): (file: string, packageName?: string) => string {
  const projectRoot = inspection.projectRoot;
  const packRoots = new Map<string, string>();
  for (const p of inspection.packs.validPacks ?? []) packRoots.set(p.packageName, p.packageRoot);
  return (file, packageName) => {
    const abs = nodePath.isAbsolute(file)
      ? file
      : nodePath.resolve((packageName && packRoots.get(packageName)) || projectRoot, file);
    return nodePath.relative(projectRoot, abs) || abs;
  };
}

async function loadStructuralEntries(
  inspection: ISharkcraftInspection,
): Promise<IStructuralMap> {
  const byKindAndFile = new Map<string, Map<string, IStructuralEntry[]>>();
  const structuralFiles = new Map<string, Set<string>>();
  const structuralIds = new Map<string, Set<string>>();
  const toRel = sourceFileResolver(inspection);

  const record = (
    kind: ContributionKind,
    file: string | undefined,
    entry: IStructuralEntry,
  ): void => {
    if (!file) return;
    const relPath = toRel(file, entry.packageName);
    const kindKey = kind as string;
    let m = byKindAndFile.get(kindKey);
    if (!m) {
      m = new Map();
      byKindAndFile.set(kindKey, m);
    }
    let arr = m.get(relPath);
    if (!arr) {
      arr = [];
      m.set(relPath, arr);
    }
    arr.push(entry);
    let fileSet = structuralFiles.get(kindKey);
    if (!fileSet) {
      fileSet = new Set();
      structuralFiles.set(kindKey, fileSet);
    }
    fileSet.add(relPath);
    // Track `(kind, packageName||local, id)` so regex fallback can
    // dedupe across multiple physical paths.
    let idSet = structuralIds.get(kindKey);
    if (!idSet) {
      idSet = new Set();
      structuralIds.set(kindKey, idSet);
    }
    const pkg = entry.packageName ?? '__local__';
    idSet.add(`${pkg}:${entry.id}`);
  };

  /** Source attribution for an inspection-backed id (knowledge/rule/path/template/pipeline/preset/boundary). */
  const attribution = (
    src: { type: 'local' | 'pack'; packageName?: string } | undefined,
  ): Pick<IStructuralEntry, 'source' | 'packageName'> =>
    src?.type === 'pack'
      ? { source: ContributionSource.Pack, ...(src.packageName ? { packageName: src.packageName } : {}) }
      : { source: ContributionSource.Local };

  // Knowledge / rules / paths / templates / pipelines come from inspection.
  for (const k of inspection.knowledgeEntries) {
    record(ContributionKind.Knowledge, k.source?.origin, {
      id: k.id,
      ...(k.title ? { title: k.title } : {}),
      ...attribution(inspection.entrySources.get(k.id)),
    });
  }
  try {
    const rules = inspection.ruleService?.list?.() ?? [];
    for (const r of rules as readonly { id: string; title?: string; source?: { origin?: string } }[]) {
      record(ContributionKind.Rule, r.source?.origin, {
        id: r.id,
        ...(r.title ? { title: r.title } : {}),
        ...attribution(inspection.entrySources.get(r.id)),
      });
    }
  } catch {
    // ignore
  }
  try {
    const paths = inspection.pathService?.list?.() ?? [];
    for (const p of paths as readonly { id: string; title?: string; source?: { origin?: string } }[]) {
      record(ContributionKind.Path, p.source?.origin, {
        id: p.id,
        ...(p.title ? { title: p.title } : {}),
        ...attribution(inspection.entrySources.get(p.id)),
      });
    }
  } catch {
    // ignore
  }
  try {
    const templates = inspection.templateRegistry?.list?.() ?? [];
    for (const t of templates as readonly { id: string; description?: string }[]) {
      const src = inspection.templateSources.get(t.id);
      record(ContributionKind.Template, src?.file, {
        id: t.id,
        ...(t.description ? { title: t.description } : {}),
        ...attribution(src),
      });
    }
  } catch {
    // ignore
  }
  try {
    const pipelines = inspection.pipelineRegistry?.list?.() ?? [];
    for (const p of pipelines as readonly { id: string; title?: string; source?: { origin?: string } }[]) {
      const src = inspection.pipelineSources.get(p.id);
      record(ContributionKind.Pipeline, src?.file ?? p.source?.origin, {
        id: p.id,
        ...(p.title ? { title: p.title } : {}),
        ...attribution(src),
      });
    }
  } catch {
    // ignore
  }
  // Presets and boundary rules: inspection-time registries with a source map.
  // A built-in preset is not a contribution (its source file reads `builtin`).
  try {
    for (const p of inspection.presetRegistry?.list?.() ?? []) {
      const src = inspection.presetSources.get(p.id);
      if (!src?.file || src.file === 'builtin') continue;
      record(ContributionKind.Preset, src.file, { id: p.id, ...(p.title ? { title: p.title } : {}), ...attribution(src) });
    }
  } catch {
    // ignore
  }
  try {
    for (const r of inspection.boundaryRegistry?.list?.() ?? []) {
      const src = inspection.boundarySources.get(r.id);
      if (!src?.file) continue;
      record(ContributionKind.Boundary, src.file, { id: r.id, ...(r.title ? { title: r.title } : {}), ...attribution(src) });
    }
  } catch {
    // ignore
  }

  // Every REGISTRY kind — helpers, conventions, routing / registration hints,
  // contract templates, migration profiles, scaffold patterns, playbooks,
  // constructs + facets, search tuning, decisions, policy checks, feedback
  // rules, tests, delegate recipes, framework extractors, the gate planes — in
  // ONE run of THE registry-outcome table, which also reports what each loader
  // refused and which files failed to load.
  const outcomes = await collectRegistryOutcomes(inspection);
  for (const a of outcomes.accepted) {
    record(a.kind, a.file, {
      id: a.id,
      ...(a.title ? { title: a.title } : {}),
      source: a.packageName ? ContributionSource.Pack : ContributionSource.Local,
      ...(a.packageName ? { packageName: a.packageName } : {}),
    });
  }

  return {
    byKindAndFile: byKindAndFile as IStructuralMap['byKindAndFile'],
    structuralFiles: structuralFiles as IStructuralMap['structuralFiles'],
    structuralIds: structuralIds as IStructuralMap['structuralIds'],
    loadFailures: outcomes.loadFailures,
    rejections: outcomes.rejections,
  };
}

/**
 * Build the inventory WITHOUT consulting the structural loaders — a regex-only
 * compatibility wrapper. Every regex id is marked `warning`
 * ("unverified: loader not consulted") unless the inspection-time loader
 * already imported that file cleanly; known load failures are still `error`.
 * Prefer {@link buildPackContributionsInventoryAsync}.
 */
export function buildPackContributionsInventory(
  inspection: ISharkcraftInspection,
): IPackContributionsInventory {
  return buildPackContributionsInventorySync(inspection, null);
}

/**
 * The inventory with structural per-kind entries loaded first — the
 * noise-free, honest variant every surface should use.
 */
export async function buildPackContributionsInventoryAsync(
  inspection: ISharkcraftInspection,
): Promise<IPackContributionsInventory> {
  const structural = await loadStructuralEntries(inspection);
  return buildPackContributionsInventorySync(inspection, structural);
}

function buildPackContributionsInventorySync(
  inspection: ISharkcraftInspection,
  structural: IStructuralMap | null,
): IPackContributionsInventory {
  const entriesByKind: Record<string, IContributionEntry[]> = {};
  const entries: IContributionEntry[] = [];
  const conflicts: IContributionConflict[] = [];
  const fileGroups = buildContribFileEntries(inspection);
  const failures = collectContributionLoadFailures(inspection, structural?.loadFailures ?? []);
  // THE rejection channel: inspection-time loaders ∪ registry loaders.
  const rejections = collectContributionRejections(inspection, structural?.rejections ?? []);
  const rejectedIdsByFile = new Map<string, Map<string, IContributionEntryRejection>>();
  for (const r of rejections) {
    if (r.entryId === undefined) continue;
    const m = rejectedIdsByFile.get(r.file) ?? new Map<string, IContributionEntryRejection>();
    if (!m.has(r.entryId)) m.set(r.entryId, r);
    rejectedIdsByFile.set(r.file, m);
  }
  // THE files a loader READ, per kind (async only): every file it accepted an
  // entry from AND every file it refused an entry of. The regex never runs on
  // a file its loader already judged — a file whose every entry was rejected
  // used to be scraped, its refused ids counted as contributions (`By kind`,
  // `totals`, the header) and grouped across packs into a false error-level
  // duplicate (round 12 review, A-2).
  const judgedFiles = new Map<string, Set<string>>();
  if (structural) {
    for (const [kindKey, files] of structural.structuralFiles) judgedFiles.set(kindKey, new Set(files));
    for (const r of rejections) {
      const rel = nodePath.relative(inspection.projectRoot, r.file) || r.file;
      const set = judgedFiles.get(r.kind) ?? new Set<string>();
      set.add(rel);
      judgedFiles.set(r.kind, set);
    }
  }
  const scrapedByFile = new Map<string, string[]>();
  const failedFilesReported = new Set<string>();
  // Files the inspection-time loaders imported cleanly (used by the sync wrapper).
  const loadedOk = new Set(
    (inspection.loaderDiagnostics ?? [])
      .filter((d) => d.status === 'ok')
      .map((d) => nodePath.resolve(d.filePath)),
  );

  const push = (entry: IContributionEntry): void => {
    (entriesByKind[entry.kind] ??= []).push(entry);
    entries.push(entry);
  };

  // First, emit structural entries (authoritative ids).
  if (structural) {
    for (const [kindKey, files] of structural.byKindAndFile) {
      for (const [relPath, list] of files) {
        for (const s of list) {
          push({
            kind: kindKey as ContributionKind,
            id: s.id,
            ...(s.title ? { title: s.title } : {}),
            source: s.source,
            ...(s.packageName ? { packageName: s.packageName } : {}),
            sourceFile: relPath,
            validation: 'ok',
            extractionMode: 'structural',
            confidence: 'high',
          });
        }
      }
    }
  }

  const ingestFile = (group: IContribFileEntry, file: string): void => {
    const abs = nodePath.resolve(file);
    const rel = nodePath.relative(inspection.projectRoot, abs) || abs;
    // Skip regex extraction when a loader already READ this (kind, file) pair
    // — accepted or refused an entry of it. Otherwise nested step.id /
    // anchor.id / sub-object ids re-appear as top-level contribution ids, and a
    // fully-rejected file's refused ids read as contributions.
    const handledKinds = [group.kind, ...(ALSO_HANDLED_BY[group.kind] ?? [])];
    if (handledKinds.some((k) => judgedFiles.get(k as string)?.has(rel))) return;

    const failure = failures.get(abs);
    const src = {
      source: group.source,
      ...(group.packageName ? { packageName: group.packageName } : {}),
      sourceFile: rel,
    };
    if (failure && !failedFilesReported.has(abs)) {
      failedFilesReported.add(abs);
      conflicts.push({
        kind: ConflictKind.InvalidContribution,
        contributionKind: group.kind,
        id: rel,
        sources: [src],
        severity: 'error',
        message: `${rel} failed to load (${failure.message}) — nothing in it takes effect; any id listed for it was scraped by regex.`,
        nextCommand: group.packageRoot
          ? `shrk packs release-check ${nodePath.relative(inspection.projectRoot, group.packageRoot) || '.'}`
          : 'shrk doctor',
      });
    }
    const content = safeRead(file);
    if (content === null) {
      push({
        kind: group.kind,
        id: rel,
        ...src,
        validation: 'error',
        validationMessage: 'file unreadable',
      });
      return;
    }
    const extracted = extractIdsFromFile(content);
    const rejectedHere = rejectedIdsByFile.get(abs);
    if (extracted.length === 0) {
      push({
        kind: group.kind,
        id: rel,
        ...src,
        validation: failure || rejectedHere ? 'error' : 'warning',
        validationMessage: failure
          ? `file failed to load (${failure.message})`
          : rejectedHere
            ? 'every entry the file declares was rejected by its loader (see rejections)'
            : 'no `id:` extracted; loader may still see entries',
        extractionMode: 'file-only',
        confidence: 'low',
      });
      return;
    }
    // Skip regex entries whose (kind, packageName||local, id) triple
    // already came in through the structural loader. This dedupes the same
    // logical pack contribution reachable from multiple physical paths
    // (e.g. `node_modules/@example/sharkcraft-pack/...` vs the dev source).
    const idsHandled = structural?.structuralIds.get(group.kind as string);
    const groupPkg = group.packageName ?? '__local__';
    for (const ex of extracted) {
      if (idsHandled && idsHandled.has(`${groupPkg}:${ex.id}`)) continue;
      const rejection = rejectedHere?.get(ex.id);
      let validation: IContributionEntry['validation'];
      let validationMessage: string | undefined;
      if (failure) {
        validation = 'error';
        validationMessage = `file failed to load (${failure.message}); id scraped by regex — this contribution does NOT take effect`;
        (scrapedByFile.get(abs) ?? scrapedByFile.set(abs, []).get(abs)!).push(ex.id);
      } else if (rejection) {
        // The loader read this entry and REFUSED it — never `ok`, never merely
        // unverified. With the loaders consulted it is in `rejections`, and a
        // refused id is no contribution row at all (round 12 review, A-2).
        if (structural) continue;
        validation = 'error';
        validationMessage = `rejected by the ${rejection.kind} loader — ${rejection.reasons.join('; ')}; this contribution does NOT take effect`;
      } else if (!structural) {
        validation = loadedOk.has(abs) ? 'ok' : 'warning';
        validationMessage = loadedOk.has(abs)
          ? undefined
          : 'unverified: loader not consulted (use the async inventory)';
      } else {
        // Every kind is loader-backed (round 12): a regex id means the loader
        // returned no entry for it — unverified, never `ok`.
        validation = 'warning';
        validationMessage = 'regex-derived; the loader returned no entries for this file';
      }
      push({
        kind: group.kind,
        id: ex.id,
        ...(ex.title ? { title: ex.title } : {}),
        ...src,
        validation,
        ...(validationMessage ? { validationMessage } : {}),
        // Regex-based id extraction can pick up nested step.id / anchor.id /
        // ref.id values. Tag these entries clearly so the conflict detector
        // downgrades same-file collisions to info.
        extractionMode: 'regex-fallback',
        confidence: failure ? 'low' : 'medium',
      });
    }
  };

  for (const group of fileGroups) {
    for (const f of group.files) ingestFile(group, f);
  }

  const totals: Record<string, number> = {};
  for (const [kind, list] of Object.entries(entriesByKind)) totals[kind] = list.length;

  for (const [kind, list] of Object.entries(entriesByKind)) {
    const byId = new Map<string, IContributionEntry[]>();
    for (const e of list) {
      // An id that does not take effect — scraped from a file that failed to
      // load, or refused by its loader — cannot collide at runtime: its own
      // load failure / rejection is already the error (round 12 review, A-2).
      if (e.validation === 'error') continue;
      const arr = byId.get(e.id) ?? [];
      arr.push(e);
      byId.set(e.id, arr);
    }
    for (const [id, arr] of byId) {
      if (arr.length < 2) continue;
      const sourceVariants = new Set(arr.map((e) => e.source));
      const conflictKind =
        sourceVariants.size > 1
          ? ConflictKind.DuplicateIdDifferentSource
          : ConflictKind.DuplicateIdSameKind;
      // If a local entry shadows a pack entry, mark it as shadowed pack/local
      // (informational; the loader behavior is documented per-kind).
      const hasLocal = arr.some((e) => e.source === ContributionSource.Local);
      const hasPack = arr.some((e) => e.source === ContributionSource.Pack);
      const sources = arr.map((e) => {
        const s: { source: ContributionSource; packageName?: string; sourceFile?: string } = {
          source: e.source,
        };
        if (e.packageName) s.packageName = e.packageName;
        if (e.sourceFile) s.sourceFile = e.sourceFile;
        return s;
      });
      if (hasLocal && hasPack) {
        conflicts.push({
          kind: ConflictKind.ShadowedPackConfig,
          contributionKind: kind as ContributionKind,
          id,
          sources,
          severity: 'info',
          message: `Local "${kind}" "${id}" shadows pack contribution. Local entries win on duplicate ids.`,
        });
      } else {
        // Self-acknowledged false positive: when ALL participating entries come
        // from a SINGLE source file via regex fallback, the "duplicate" is
        // almost certainly nested `id:` fields (playbook.steps[].id /
        // pipeline.steps[].id) the regex grabbed, not real top-level duplicate
        // contribution ids. Don't emit noise for it — a genuine duplicate would
        // span multiple files or include a non-regex-fallback entry and still
        // surface as an error below.
        const allRegexFallback = arr.every((e) => e.extractionMode === 'regex-fallback');
        const sourceFiles = new Set(arr.map((e) => e.sourceFile).filter((s): s is string => Boolean(s)));
        if (allRegexFallback && sourceFiles.size === 1) continue;
        conflicts.push({
          kind: conflictKind,
          contributionKind: kind as ContributionKind,
          id,
          sources,
          severity: 'error',
          message: `Duplicate "${kind}" id "${id}" loaded from ${arr.length} sources.`,
          nextCommand: `shrk packs contributions --json | jq '.entries[] | select(.id=="${id}" and .kind=="${kind}")'`,
        });
      }
    }
  }

  // Stale-signature: read from THE pack-asset freshness authority (content
  // digests recorded at sign time), never from mtimes. Dev-signed packs are
  // re-staled by every local build and load fine locally, so their divergence
  // is not a conflict (mirrors pack-signature-status's dev downgrade).
  for (const pack of inspection.packs.validPacks ?? []) {
    if (!pack.manifest?.signature) continue;
    const freshness = detectPackAssetFreshness(pack);
    if (freshness.signature.state !== 'diverged' || freshness.signature.dev) continue;
    conflicts.push({
      kind: ConflictKind.StaleSignature,
      contributionKind: ContributionKind.Docs,
      id: pack.packageName,
      sources: [{ source: ContributionSource.Pack, packageName: pack.packageName, sourceFile: pack.packageRoot }],
      severity: 'warning',
      message: describePackAssetFreshness(freshness).signature ?? `Pack ${pack.packageName} signature is stale.`,
      nextCommand: `SHARKCRAFT_PACK_SECRET=<secret> shrk packs sign ${nodePath.relative(inspection.projectRoot, pack.packageRoot)}`,
    });
  }

  const extractionTotals = {
    structural: entries.filter((e) => e.extractionMode === 'structural').length,
    regexFallback: entries.filter((e) => e.extractionMode === 'regex-fallback').length,
    fileOnly: entries.filter((e) => e.extractionMode === 'file-only').length,
    rejected: rejections.length,
  };
  const loadFailures = [...failures.values()]
    .map((f) => ({
      file: nodePath.relative(inspection.projectRoot, f.file) || f.file,
      kind: f.kind,
      ...(f.packageName ? { packageName: f.packageName } : {}),
      message: f.message,
      scrapedIds: [...(scrapedByFile.get(f.file) ?? [])],
    }))
    .sort((a, b) => a.file.localeCompare(b.file));

  return {
    schema: PACK_CONTRIBUTIONS_INVENTORY_SCHEMA,
    generatedAt: new Date().toISOString(),
    projectRoot: inspection.projectRoot,
    entriesByKind,
    totals,
    entries,
    conflicts,
    packs: (inspection.packs.validPacks ?? []).map((p) => ({
      name: p.packageName,
      version: p.packageVersion,
      root: p.packageRoot,
      signaturePresent: Boolean(p.manifest?.signature),
    })),
    extractionTotals,
    loadFailures,
    rejections: rejections.map((r) => ({
      file: nodePath.relative(inspection.projectRoot, r.file) || r.file,
      kind: r.kind,
      ...(r.packageName ? { packageName: r.packageName } : {}),
      index: r.index,
      ...(r.exportName ? { exportName: r.exportName } : {}),
      ...(r.entryId !== undefined ? { entryId: r.entryId } : {}),
      reasons: r.reasons,
      cause: r.cause,
    })),
    mode: structural ? 'async' : 'sync',
  };
}

/** Per-kind extraction-mode counts over `entries` (so a filtered view renders its own numbers). */
function modeCountsByKind(
  entries: readonly IContributionEntry[],
): Map<string, { total: number; structural: number; regexFallback: number; fileOnly: number }> {
  const out = new Map<string, { total: number; structural: number; regexFallback: number; fileOnly: number }>();
  for (const e of entries) {
    const c = out.get(e.kind) ?? { total: 0, structural: 0, regexFallback: 0, fileOnly: 0 };
    c.total += 1;
    if (e.extractionMode === 'structural') c.structural += 1;
    else if (e.extractionMode === 'regex-fallback') c.regexFallback += 1;
    else if (e.extractionMode === 'file-only') c.fileOnly += 1;
    out.set(e.kind, c);
  }
  return out;
}

function modeClause(c: { structural: number; regexFallback: number; fileOnly: number }): string {
  const parts: string[] = [];
  if (c.structural > 0) parts.push(`structural ${c.structural}`);
  if (c.regexFallback > 0) parts.push(`regex-fallback ${c.regexFallback}`);
  if (c.fileOnly > 0) parts.push(`file-only ${c.fileOnly}`);
  return parts.length > 0 ? `(${parts.join(' · ')})` : '';
}

function extractionLine(entries: readonly IContributionEntry[], rejected: number): string {
  const s = entries.filter((e) => e.extractionMode === 'structural').length;
  const r = entries.filter((e) => e.extractionMode === 'regex-fallback').length;
  const f = entries.filter((e) => e.extractionMode === 'file-only').length;
  return `${s} structural · ${r} regex-fallback (unverified) · ${f} file-only${rejected > 0 ? ` · ${rejected} REJECTED` : ''}`;
}

export function renderInventoryText(inv: IPackContributionsInventory): string {
  const lines: string[] = [];
  const rejections = inv.rejections ?? [];
  lines.push(`=== Pack contributions inventory (${inv.entries.length} entries) ===`);
  lines.push(`  generatedAt   ${inv.generatedAt}`);
  lines.push(`  packs         ${inv.packs.length}`);
  for (const p of inv.packs) lines.push(`    • ${p.name}@${p.version} (sig: ${p.signaturePresent ? 'present' : 'absent'})`);
  lines.push(`  extraction    ${extractionLine(inv.entries, rejections.length)}`);
  if (inv.mode === 'sync') lines.push('  mode          sync — loaders NOT consulted; regex ids are unverified');
  lines.push('');
  lines.push(`By kind:`);
  const byKind = modeCountsByKind(inv.entries);
  for (const k of [...byKind.keys()].sort()) {
    const c = byKind.get(k)!;
    lines.push(`  ${k.padEnd(28)} ${String(c.total).padStart(4)}  ${modeClause(c)}`.trimEnd());
  }
  lines.push('');
  const failures = inv.loadFailures ?? [];
  if (failures.length > 0) {
    lines.push(`Load failures (${failures.length}):`);
    for (const f of failures) {
      lines.push(`  ✗ ${f.file}  [${f.kind}${f.packageName ? `, ${f.packageName}` : ''}] — ${f.message}`);
      lines.push(
        `      regex-scraped ids NOT loaded: ${f.scrapedIds.length > 0 ? f.scrapedIds.join(', ') : '(none)'}`,
      );
    }
    lines.push('');
  }
  if (rejections.length > 0) {
    lines.push(`Rejected entries (${rejections.length}) — refused by their loader, NOT in effect:`);
    let lastFile = '';
    for (const r of rejections) {
      if (r.file !== lastFile) {
        lines.push(`  ✗ ${r.file}  [${r.kind}${r.packageName ? `, ${r.packageName}` : ''}]`);
        lastFile = r.file;
      }
      lines.push(`      ${formatEntryRejection(r)}`);
    }
    lines.push('');
  }
  if (inv.conflicts.length > 0) {
    lines.push(`Conflicts (${inv.conflicts.length}):`);
    for (const c of inv.conflicts.slice(0, 50)) {
      lines.push(`  ${c.severity.padEnd(7)} [${c.kind}] ${c.contributionKind} "${c.id}" — ${c.message}`);
      if (c.nextCommand) lines.push(`         next: ${c.nextCommand}`);
    }
  } else {
    lines.push('No conflicts detected.');
  }
  return lines.join('\n') + '\n';
}

export function renderInventoryMarkdown(inv: IPackContributionsInventory): string {
  const lines: string[] = [];
  const rejections = inv.rejections ?? [];
  lines.push('# Pack contributions inventory');
  lines.push('');
  lines.push(`- generatedAt: ${inv.generatedAt}`);
  lines.push(`- packs: ${inv.packs.length}`);
  for (const p of inv.packs) {
    lines.push(`  - **${p.name}** \`${p.version}\` (signature ${p.signaturePresent ? 'present' : 'absent'})`);
  }
  lines.push(`- extraction: ${extractionLine(inv.entries, rejections.length)}`);
  if (inv.mode === 'sync') lines.push('- mode: sync — loaders NOT consulted; regex ids are unverified');
  lines.push('');
  lines.push('## By kind');
  lines.push('| Kind | Count | Structural | Regex-fallback | File-only |');
  lines.push('| --- | --- | --- | --- | --- |');
  const byKind = modeCountsByKind(inv.entries);
  for (const k of [...byKind.keys()].sort()) {
    const c = byKind.get(k)!;
    lines.push(`| \`${k}\` | ${c.total} | ${c.structural} | ${c.regexFallback} | ${c.fileOnly} |`);
  }
  lines.push('');
  lines.push('## Load failures');
  const failures = inv.loadFailures ?? [];
  if (failures.length === 0) {
    lines.push('None.');
  } else {
    lines.push('| File | Kind | Pack | Error | Regex-scraped ids NOT loaded |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const f of failures) {
      lines.push(
        `| \`${f.file}\` | ${f.kind} | ${f.packageName ?? ''} | ${f.message} | ${f.scrapedIds.join(', ')} |`,
      );
    }
  }
  lines.push('');
  lines.push('## Rejected entries');
  if (rejections.length === 0) {
    lines.push('None.');
  } else {
    lines.push('| File | Kind | Pack | Entry | Reasons |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const r of rejections) {
      // THE slot label (round 15 closing review, A5): a whole Markdown document
      // printed `[-1]` here; every other surface reads `rejectedEntrySlot`.
      lines.push(
        `| \`${r.file}\` | ${r.kind} | ${r.packageName ?? ''} | ${r.entryId !== undefined ? `\`${r.entryId}\`` : '(no id)'} (${rejectedEntrySlot(r)}) | ${r.reasons.join('; ')} |`,
      );
    }
  }
  lines.push('');
  lines.push('## Conflicts');
  if (inv.conflicts.length === 0) {
    lines.push('None.');
  } else {
    lines.push('| Severity | Kind | Contribution | Id | Message |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const c of inv.conflicts) {
      lines.push(`| ${c.severity} | \`${c.kind}\` | \`${c.contributionKind}\` | \`${c.id}\` | ${c.message} |`);
    }
  }
  return lines.join('\n') + '\n';
}

export function selectConflicts(
  inv: IPackContributionsInventory,
): readonly IContributionConflict[] {
  return inv.conflicts;
}

/**
 * Per contribution kind, a pack's declared FILES, ACCEPTED entries and
 * REJECTED entries — THE projection of this inventory that `packs list`,
 * `packs get` and MCP `list_packs` / `get_pack` print (round 12, 12.1b), so
 * a partially-loaded file never looks like a fully-loaded one and every
 * surface counts what `packs contributions` counts. A kind with nothing
 * declared, accepted or rejected is absent.
 */
export function packEntryCounts(
  inv: IPackContributionsInventory | null,
  pack: { readonly packageName: string; readonly contributionCounts: Readonly<Record<string, number | undefined>> },
): Record<string, { files: number; accepted: number; rejected: number }> {
  const out: Record<string, { files: number; accepted: number; rejected: number }> = {};
  const row = (kind: string): { files: number; accepted: number; rejected: number } =>
    (out[kind] ??= { files: 0, accepted: 0, rejected: 0 });
  for (const slot of CONTRIBUTION_FILE_KEYS) {
    const n = pack.contributionCounts[slot] ?? 0;
    if (n === 0) continue;
    row(contributionKindForSlot(slot) ?? slot).files += n;
  }
  for (const e of inv?.entries ?? []) {
    if (e.packageName !== pack.packageName || e.extractionMode !== 'structural') continue;
    row(e.kind).accepted += 1;
  }
  for (const r of inv?.rejections ?? []) {
    if (r.packageName !== pack.packageName) continue;
    row(r.kind).rejected += 1;
  }
  return out;
}
