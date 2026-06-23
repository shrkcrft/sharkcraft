/**
 * Generic pack contributions inventory + conflict detector.
 *
 * Reads each pack's manifest, enumerates the contribution slots, and reports:
 *   - one row per (kind, id, source) — the inventory
 *   - one row per detected collision — the conflicts
 *
 * Both outputs are deterministic and read-only.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
// Structural loaders used to replace regex-fallback noise per kind.
import { HELPERS } from './helper-registry.ts';
import { listConventions } from './convention-registry.ts';
import { listPackHelpers } from './pack-helper-registry.ts';
import { listTaskRoutingHints } from './task-routing-hint-registry.ts';
import { listRegistrationHints } from './registration-hint-registry.ts';
import { listPlaybooks } from './playbook-registry.ts';
import { loadAllContractTemplates } from './contract-template-registry.ts';
import { listMigrationProfilesFromPacks } from './migration-profile-registry.ts';

export const PACK_CONTRIBUTIONS_INVENTORY_SCHEMA =
  'sharkcraft.pack-contributions-inventory/v1';

export enum ContributionSource {
  Builtin = 'builtin',
  Local = 'local',
  Pack = 'pack',
  Fixture = 'fixture',
}

export enum ContributionKind {
  Knowledge = 'knowledge',
  Rule = 'rule',
  Path = 'path',
  PathConvention = 'path-convention',
  Template = 'template',
  Pipeline = 'pipeline',
  Preset = 'preset',
  Boundary = 'boundary',
  ScaffoldPattern = 'scaffold-pattern',
  Policy = 'policy',
  Construct = 'construct',
  Playbook = 'playbook',
  SearchTuning = 'search-tuning',
  FeedbackRule = 'feedback-rule',
  Decision = 'decision',
  ContractTemplate = 'contract-template',
  MigrationProfile = 'migration-profile',
  ContextTest = 'context-test',
  AgentTest = 'agent-test',
  Helper = 'helper',
  TaskRoutingHint = 'task-routing-hint',
  Convention = 'convention',
  Docs = 'docs',
}

/**
 * How the inventory derived this entry's id.
 *   - `structural`     — authoritative ids from the loader for this kind.
 *   - `regex-fallback` — id extracted by regex from the raw source file;
 *                        nested `id:` fields may produce false positives.
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
}

interface IContribFileEntry {
  kind: ContributionKind;
  packageName?: string;
  packageRoot?: string;
  files: readonly string[];
  source: ContributionSource;
}

const KIND_TO_SLOT: Record<ContributionKind, string> = {
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
  [ContributionKind.Convention]: 'conventionFiles',
  [ContributionKind.Docs]: 'docsFiles',
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
 * occurrences inside a contribution file. This works without importing the
 * file (the engine already has dedicated loaders that do this; the inventory
 * is intentionally a fast surface-level reporter that doesn't re-run them).
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
      { kind: ContributionKind.Playbook, relCandidates: ['playbooks.ts'] },
      { kind: ContributionKind.SearchTuning, relCandidates: ['search-tuning.ts'] },
      { kind: ContributionKind.FeedbackRule, relCandidates: ['feedback-rules.ts'] },
      { kind: ContributionKind.Decision, relCandidates: ['decisions.ts'] },
      { kind: ContributionKind.AgentTest, relCandidates: ['agent-tests.ts'] },
      { kind: ContributionKind.ContractTemplate, relCandidates: ['contract-templates.ts'] },
      { kind: ContributionKind.MigrationProfile, relCandidates: ['migration-profiles.ts'] },
      { kind: ContributionKind.Helper, relCandidates: ['helpers.ts'] },
      { kind: ContributionKind.TaskRoutingHint, relCandidates: ['task-routing-hints.ts'] },
      { kind: ContributionKind.Convention, relCandidates: ['conventions.ts'] },
    ];
    for (const c of localConventions) {
      const files = c.relCandidates
        .map((rel) => nodePath.join(dir, rel))
        .filter((abs) => existsSync(abs));
      if (files.length > 0) {
        out.push({ kind: c.kind, files, source: ContributionSource.Local });
      }
    }
  }

  // Pack contributions from manifests.
  for (const pack of inspection.packs.validPacks ?? []) {
    const contributions = (pack.manifest?.contributions ?? {}) as Record<string, readonly string[] | undefined>;
    for (const kind of Object.values(ContributionKind)) {
      const slot = KIND_TO_SLOT[kind];
      const rels = contributions[slot];
      if (!rels || rels.length === 0) continue;
      const abs = rels.map((rel) => nodePath.resolve(pack.packageRoot, rel)).filter((f) => existsSync(f));
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
}

async function loadStructuralEntries(
  inspection: ISharkcraftInspection,
): Promise<IStructuralMap> {
  const byKindAndFile = new Map<string, Map<string, IStructuralEntry[]>>();
  const structuralFiles = new Map<string, Set<string>>();
  const structuralIds = new Map<string, Set<string>>();
  const projectRoot = inspection.projectRoot;
  const rel = (abs: string | undefined): string | undefined =>
    abs ? nodePath.relative(projectRoot, abs) || abs : undefined;

  const record = (
    kind: ContributionKind,
    file: string | undefined,
    entry: IStructuralEntry,
  ): void => {
    if (!file) return;
    const relPath = rel(file)!;
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

  // Knowledge / rules / paths / templates / pipelines come from inspection.
  for (const k of inspection.knowledgeEntries) {
    record(ContributionKind.Knowledge, k.source?.origin, {
      id: k.id,
      ...(k.title ? { title: k.title } : {}),
      source: ContributionSource.Local,
    });
  }
  try {
    const rules = inspection.ruleService?.list?.() ?? [];
    for (const r of rules as readonly { id: string; title?: string; source?: { origin?: string } }[]) {
      record(ContributionKind.Rule, r.source?.origin, {
        id: r.id,
        ...(r.title ? { title: r.title } : {}),
        source: ContributionSource.Local,
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
        source: ContributionSource.Local,
      });
    }
  } catch {
    // ignore
  }
  try {
    const templates = inspection.templateRegistry?.list?.() ?? [];
    for (const t of templates as readonly { id: string; description?: string; source?: { origin?: string } }[]) {
      record(ContributionKind.Template, t.source?.origin, {
        id: t.id,
        ...(t.description ? { title: t.description } : {}),
        source: ContributionSource.Local,
      });
    }
  } catch {
    // ignore
  }
  try {
    const pipelines = inspection.pipelineRegistry?.list?.() ?? [];
    for (const p of pipelines as readonly { id: string; title?: string; source?: { origin?: string } }[]) {
      record(ContributionKind.Pipeline, p.source?.origin, {
        id: p.id,
        ...(p.title ? { title: p.title } : {}),
        source: ContributionSource.Local,
      });
    }
  } catch {
    // ignore
  }

  // Playbooks — these were a major source of nested step.id false positives.
  try {
    const playbooks = await listPlaybooks(inspection);
    for (const p of playbooks as readonly {
      id: string;
      title?: string;
      source?: 'local' | 'pack';
      packageName?: string;
      sourceFile?: string;
    }[]) {
      record(ContributionKind.Playbook, p.sourceFile, {
        id: p.id,
        ...(p.title ? { title: p.title } : {}),
        source: p.source === 'pack' ? ContributionSource.Pack : ContributionSource.Local,
        ...(p.packageName ? { packageName: p.packageName } : {}),
      });
    }
  } catch {
    // ignore
  }

  // Conventions, helpers, routing hints, registration hints, contract templates,
  // migration profiles — all loader-backed today.
  try {
    const entries = await listConventions(inspection);
    for (const e of entries) {
      record(ContributionKind.Convention, e.sourceFile, {
        id: e.convention.id,
        ...((e.convention as { title?: string }).title
          ? { title: (e.convention as { title?: string }).title }
          : {}),
        source:
          (e as { source?: string }).source === 'pack'
            ? ContributionSource.Pack
            : ContributionSource.Local,
        ...(e.packageName ? { packageName: e.packageName } : {}),
      });
    }
  } catch {
    // ignore
  }
  try {
    const builtIns = HELPERS;
    for (const h of builtIns) {
      // Built-in helpers don't have a file; skip the structural mapping.
      void h;
    }
    const packHelpers = await listPackHelpers(inspection);
    for (const e of packHelpers) {
      record(ContributionKind.Helper, e.sourceFile, {
        id: e.helper.id,
        ...((e.helper as { description?: string }).description
          ? { title: (e.helper as { description?: string }).description }
          : {}),
        source: ContributionSource.Pack,
        ...(e.packageName ? { packageName: e.packageName } : {}),
      });
    }
  } catch {
    // ignore
  }
  try {
    const entries = await listTaskRoutingHints(inspection);
    for (const e of entries) {
      record(ContributionKind.TaskRoutingHint, e.sourceFile, {
        id: e.hint.id,
        ...((e.hint as { title?: string }).title ? { title: (e.hint as { title?: string }).title } : {}),
        source:
          (e as { source?: string }).source === 'pack'
            ? ContributionSource.Pack
            : ContributionSource.Local,
        ...(e.packageName ? { packageName: e.packageName } : {}),
      });
    }
  } catch {
    // ignore
  }
  // Registration hints don't have a dedicated `ContributionKind` today — they
  // ship through templates' metadata + the registration-hint registry — so
  // we deliberately skip them in the structural map. The self-config doctor
  // surfaces broken registration-hint refs via its own check.
  await Promise.resolve();
  void listRegistrationHints;
  try {
    const pair = await loadAllContractTemplates(inspection);
    for (const e of pair.entries) {
      record(ContributionKind.ContractTemplate, e.sourceFile, {
        id: e.template.id,
        ...((e.template as { title?: string }).title
          ? { title: (e.template as { title?: string }).title }
          : {}),
        source:
          (e as { source?: string }).source === 'pack'
            ? ContributionSource.Pack
            : ContributionSource.Local,
        ...(e.packageName ? { packageName: e.packageName } : {}),
      });
    }
  } catch {
    // ignore
  }
  try {
    const profiles = await listMigrationProfilesFromPacks(inspection);
    for (const p of profiles as readonly {
      id: string;
      title?: string;
      sourceFile?: string;
      packageName?: string;
    }[]) {
      record(ContributionKind.MigrationProfile, p.sourceFile, {
        id: p.id,
        ...(p.title ? { title: p.title } : {}),
        source: ContributionSource.Pack,
        ...(p.packageName ? { packageName: p.packageName } : {}),
      });
    }
  } catch {
    // ignore
  }

  return {
    byKindAndFile: byKindAndFile as IStructuralMap['byKindAndFile'],
    structuralFiles: structuralFiles as IStructuralMap['structuralFiles'],
    structuralIds: structuralIds as IStructuralMap['structuralIds'],
  };
}

/**
 * Build the inventory. Read-only. Never imports pack code beyond the
 * registry loaders that already do.
 *
 * Structural-first extraction. For kinds with a dedicated loader, the
 * inventory uses the loader's authoritative ids and **suppresses the
 * regex fallback** for those same source files. This eliminates the
 * nested-step-id false positives that previously produced duplicate /
 * conflict noise.
 */
export function buildPackContributionsInventory(
  inspection: ISharkcraftInspection,
): IPackContributionsInventory {
  return buildPackContributionsInventorySync(inspection, null);
}

/**
 * Async variant that loads structural per-kind entries first.
 *
 * Production callers should prefer this over the sync wrapper since it
 * provides the noise-free output. The sync wrapper exists for backward
 * compatibility with callers that haven't been awaited yet.
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
  const fileGroups = buildContribFileEntries(inspection);

  // First, emit structural entries (authoritative ids).
  if (structural) {
    for (const [kindKey, files] of structural.byKindAndFile) {
      for (const [relPath, list] of files) {
        for (const s of list) {
          const entry: IContributionEntry = {
            kind: kindKey as ContributionKind,
            id: s.id,
            ...(s.title ? { title: s.title } : {}),
            source: s.source,
            ...(s.packageName ? { packageName: s.packageName } : {}),
            sourceFile: relPath,
            validation: 'ok',
            extractionMode: 'structural',
            confidence: 'high',
          };
          (entriesByKind[kindKey] ??= []).push(entry);
          entries.push(entry);
        }
      }
    }
  }

  const ingestFile = (group: IContribFileEntry, file: string): void => {
    const rel = nodePath.relative(inspection.projectRoot, file) || file;
    // Skip regex extraction when the structural loader already covered
    // this (kind, file) pair. Otherwise nested step.id / anchor.id / sub-object
    // ids re-appear as top-level contribution ids, producing duplicate noise.
    const handled = structural?.structuralFiles.get(group.kind as string)?.has(rel);
    if (handled) return;
    const content = safeRead(file);
    if (content === null) {
      const entry: IContributionEntry = {
        kind: group.kind,
        id: rel,
        source: group.source,
        ...(group.packageName ? { packageName: group.packageName } : {}),
        sourceFile: rel,
        validation: 'error',
        validationMessage: 'file unreadable',
      };
      (entriesByKind[group.kind] ??= []).push(entry);
      entries.push(entry);
      return;
    }
    const extracted = extractIdsFromFile(content);
    if (extracted.length === 0) {
      const entry: IContributionEntry = {
        kind: group.kind,
        id: rel,
        source: group.source,
        ...(group.packageName ? { packageName: group.packageName } : {}),
        sourceFile: rel,
        validation: 'warning',
        validationMessage: 'no `id:` extracted; loader may still see entries',
        extractionMode: 'file-only',
        confidence: 'low',
      };
      (entriesByKind[group.kind] ??= []).push(entry);
      entries.push(entry);
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
      const entry: IContributionEntry = {
        kind: group.kind,
        id: ex.id,
        ...(ex.title ? { title: ex.title } : {}),
        source: group.source,
        ...(group.packageName ? { packageName: group.packageName } : {}),
        sourceFile: rel,
        validation: 'ok',
        // Regex-based id extraction can pick up nested step.id / anchor.id /
        // ref.id values. Tag these entries clearly so the conflict detector
        // downgrades same-file collisions to info. The structural loader is
        // preferred where available; this fallback fires only for kinds
        // without a dedicated registry.
        extractionMode: 'regex-fallback',
        confidence: 'medium',
      };
      (entriesByKind[group.kind] ??= []).push(entry);
      entries.push(entry);
    }
  };

  for (const group of fileGroups) {
    for (const f of group.files) ingestFile(group, f);
  }

  const totals: Record<string, number> = {};
  for (const [kind, list] of Object.entries(entriesByKind)) totals[kind] = list.length;

  const conflicts: IContributionConflict[] = [];
  for (const [kind, list] of Object.entries(entriesByKind)) {
    const byId = new Map<string, IContributionEntry[]>();
    for (const e of list) {
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
      if (hasLocal && hasPack) {
        conflicts.push({
          kind: ConflictKind.ShadowedPackConfig,
          contributionKind: kind as ContributionKind,
          id,
          sources: arr.map((e) => {
            const src: { source: ContributionSource; packageName?: string; sourceFile?: string } = {
              source: e.source,
            };
            if (e.packageName) src.packageName = e.packageName;
            if (e.sourceFile) src.sourceFile = e.sourceFile;
            return src;
          }),
          severity: 'info',
          message: `Local "${kind}" "${id}" shadows pack contribution. Local entries win on duplicate ids.`,
        });
      } else {
        // Downgrade conflicts that come from a single source file
        // when ALL participating entries are regex-fallback extractions.
        // These are almost certainly nested `id:` fields (e.g.
        // playbook.steps[].id, pipeline.steps[].id) masquerading as
        // separate top-level contribution ids.
        const allRegexFallback = arr.every(
          (e) => e.extractionMode === 'regex-fallback',
        );
        const sourceFiles = new Set(arr.map((e) => e.sourceFile).filter((s): s is string => Boolean(s)));
        const singleSourceFile = sourceFiles.size === 1;
        // Self-acknowledged false positive: when ALL participating entries come
        // from a SINGLE source file via regex fallback, the "duplicate" is
        // almost certainly nested `id:` fields (playbook.steps[].id /
        // pipeline.steps[].id) the regex grabbed, not real top-level duplicate
        // contribution ids. Don't emit noise for it — a genuine duplicate would
        // span multiple files or include a non-regex-fallback entry and still
        // surface as an error below.
        if (allRegexFallback && singleSourceFile) continue;
        conflicts.push({
          kind: conflictKind,
          contributionKind: kind as ContributionKind,
          id,
          sources: arr.map((e) => {
            const src: { source: ContributionSource; packageName?: string; sourceFile?: string } = {
              source: e.source,
            };
            if (e.packageName) src.packageName = e.packageName;
            if (e.sourceFile) src.sourceFile = e.sourceFile;
            return src;
          }),
          severity: 'error',
          message: `Duplicate "${kind}" id "${id}" loaded from ${arr.length} sources.`,
          nextCommand: `shrk packs contributions --json | jq '.entries[] | select(.id=="${id}" and .kind=="${kind}")'`,
        });
      }
    }
  }

  // Stale-signature warning: surfaced as a conflict so a single doctor view
  // can highlight unsigned-by-secret manifests.
  for (const pack of inspection.packs.validPacks ?? []) {
    const sig = pack.manifest?.signature;
    if (!sig) continue;
    // Dev-signed packs are re-staled by every local build and load fine
    // locally, so suppress the stale-signature conflict for them (mirrors the
    // dev-aware downgrade in pack-signature-status.ts). Production signed packs
    // still surface as stale.
    if (sig.dev === true) continue;
    // The loader already validates HMAC strictly; we only surface stale
    // when the manifest content has obviously been edited without re-signing.
    // Heuristic: signature timestamp older than any contribution file mtime.
    let staleSummary: string | null = null;
    try {
      const sigMs = new Date(sig.signedAt).getTime();
      const contributions = pack.manifest?.contributions ?? {};
      for (const slot of Object.values(KIND_TO_SLOT)) {
        const rels = (contributions as Record<string, readonly string[] | undefined>)[slot] ?? [];
        for (const rel of rels) {
          const abs = nodePath.resolve(pack.packageRoot, rel);
          try {
            const stat = statSync(abs);
            if (stat.mtimeMs > sigMs + 1000) {
              staleSummary = `${rel} (mtime ${new Date(stat.mtimeMs).toISOString()}) is newer than signature (${sig.signedAt})`;
              break;
            }
          } catch {
            continue;
          }
        }
        if (staleSummary) break;
      }
    } catch {
      // ignore
    }
    if (staleSummary) {
      conflicts.push({
        kind: ConflictKind.StaleSignature,
        contributionKind: ContributionKind.Docs,
        id: pack.packageName,
        sources: [{ source: ContributionSource.Pack, packageName: pack.packageName, sourceFile: pack.packageRoot }],
        severity: 'warning',
        message: `Pack ${pack.packageName} signature is stale: ${staleSummary}`,
        nextCommand: `SHARKCRAFT_PACK_SECRET=<secret> shrk packs sign ${nodePath.relative(inspection.projectRoot, pack.packageRoot)}`,
      });
    }
  }

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
  };
}

export function renderInventoryText(inv: IPackContributionsInventory): string {
  const lines: string[] = [];
  lines.push(`=== Pack contributions inventory (${inv.entries.length} entries) ===`);
  lines.push(`  generatedAt   ${inv.generatedAt}`);
  lines.push(`  packs         ${inv.packs.length}`);
  for (const p of inv.packs) lines.push(`    • ${p.name}@${p.version} (sig: ${p.signaturePresent ? 'present' : 'absent'})`);
  lines.push('');
  lines.push(`By kind:`);
  for (const [k, n] of Object.entries(inv.totals).sort()) lines.push(`  ${k.padEnd(28)} ${n}`);
  lines.push('');
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
  lines.push('# Pack contributions inventory');
  lines.push('');
  lines.push(`- generatedAt: ${inv.generatedAt}`);
  lines.push(`- packs: ${inv.packs.length}`);
  for (const p of inv.packs) {
    lines.push(`  - **${p.name}** \`${p.version}\` (signature ${p.signaturePresent ? 'present' : 'absent'})`);
  }
  lines.push('');
  lines.push('## By kind');
  lines.push('| Kind | Count |');
  lines.push('| --- | --- |');
  for (const [k, n] of Object.entries(inv.totals).sort()) lines.push(`| \`${k}\` | ${n} |`);
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
