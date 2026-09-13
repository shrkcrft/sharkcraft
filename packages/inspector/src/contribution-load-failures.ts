/**
 * THE answer to "which contribution files failed to load?" — and, since round
 * 12 (12.1), to "which contributed ENTRIES did a loader refuse?".
 *
 * A file the module loader cannot import used to be scraped by regex and every
 * scraped id reported `validation: 'ok'` — a broken asset that did not take
 * effect while every diagnostic said the pack was healthy. The contributions
 * inventory, `packs doctor` and the release gate now read the same failure map,
 * built from data the engine already computed:
 *
 *   - `inspection.loaderDiagnostics` — the inspection-time loaders (knowledge,
 *     rules, paths, docs, templates, pipelines, presets, boundaries), status
 *     `failed` / `timeout` / a `cached-skip` of a prior failure, and each
 *     file's `rejected` entries;
 *   - EVERY registry loader's `load-failed` issues and `rejected` entries —
 *     gathered in ONE run by {@link collectRegistryOutcomes}.
 *
 * An ENTRY a loader refused (a missing required field, a duplicate id) used to
 * be a silent `continue`: the list verb printed the survivors and every doctor
 * said zero errors. Every loader now returns it as an `IRejectedEntry`, and
 * this module is the one channel that carries it to every surface.
 *
 * No second loader, no parallel import path: `importModuleViaLoader` remembers
 * a failed module, so re-asking a registry is a deterministic rejection.
 */
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IRejectedEntry } from '@shrkcrft/core';
import { ContributionKind } from './contribution-kind.ts';
import type { LoaderAssetKind } from './inspector-cache.ts';
import { loadAllContractTemplates } from './contract-template-registry.ts';
import { loadConstructsWithIssues } from './construct-registry.ts';
import { loadConventions } from './convention-registry.ts';
import { loadTsDecisionsWithIssues } from './decision-records.ts';
import { loadDelegateRecipesFromPacks } from './delegate-pack-recipes.ts';
import { loadFeedbackRulesWithIssues } from './feedback-ingestion.ts';
import { loadFrameworkExtractorOutcomes } from './framework-extractor-outcomes.ts';
import { listAllHelpers } from './helper-catalog.ts';
import type { IContributionAcceptedEntry } from './i-contribution-accepted-entry.ts';
import type { IContributionEntryRejection } from './i-contribution-entry-rejection.ts';
import type { IKindOutcomes } from './i-kind-outcomes.ts';
import type { IRegistryOutcomes } from './i-registry-outcomes.ts';
import { loadMigrationProfiles } from './migration-profile-registry.ts';
import { loadPlaybooksWithIssues } from './playbook-registry.ts';
import { loadPolicyDeclarationsWithIssues } from './policy-registry.ts';
import { loadRegistrationHints } from './registration-hint-registry.ts';
import { resolveProjectConfig } from './resolve-project-config.ts';
import { loadScaffoldPatternsFromInspection } from './scaffold-patterns.ts';
import { loadSearchTuning } from './search-tuning-registry.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { loadTaskRoutingHints } from './task-routing-hint-registry.ts';

export interface IContributionLoadFailure {
  /** Absolute path of the file that failed to load. */
  readonly file: string;
  /** The loader kind that tried it (`knowledge`, `templates`, `helper`, `convention`, …). */
  readonly kind: string;
  /** Owning pack, when the file is a pack contribution. */
  readonly packageName?: string;
  /** First line of the underlying error. */
  readonly message: string;
  /** Which evidence reported it. */
  readonly via: 'loader-diagnostics' | 'registry';
}

function firstLine(s: string): string {
  return (s.split('\n')[0] ?? s).trim();
}

/** The valid pack whose root contains `abs`, if any. */
function owningPack(inspection: ISharkcraftInspection, abs: string): string | undefined {
  for (const p of inspection.packs.validPacks ?? []) {
    const root = nodePath.resolve(p.packageRoot) + nodePath.sep;
    if (abs.startsWith(root)) return p.packageName;
  }
  return undefined;
}

/** Resolve a registry issue's `source` (absolute, project- or pack-relative) to an existing absolute file. */
function resolveIssueSource(inspection: ISharkcraftInspection, source: string): string {
  if (nodePath.isAbsolute(source)) return nodePath.resolve(source);
  const roots = [
    inspection.projectRoot,
    ...(inspection.sharkcraftDir ? [inspection.sharkcraftDir] : []),
    ...(inspection.packs.validPacks ?? []).map((p) => p.packageRoot),
  ];
  for (const r of roots) {
    const abs = nodePath.resolve(r, source);
    if (existsSync(abs)) return abs;
  }
  return nodePath.resolve(inspection.projectRoot, source);
}

/**
 * A registry entry's `sourceFile` as an absolute path: registries report a
 * PACK-relative path for pack entries and a PROJECT-relative one for local
 * entries (`nodePath.resolve` against `process.cwd()` made both cwd-dependent).
 * The self-config doctor attributes an unresolvable reference to its file
 * through this same resolution.
 */
export function resolveEntryFile(inspection: ISharkcraftInspection, file: string, packageName?: string): string {
  if (nodePath.isAbsolute(file)) return nodePath.resolve(file);
  const packRoot = packageName
    ? (inspection.packs.validPacks ?? []).find((p) => p.packageName === packageName)?.packageRoot
    : undefined;
  return nodePath.resolve(packRoot ?? inspection.projectRoot, file);
}

/** A contribution file as every surface prints it: project-relative (POSIX), or absolute when outside the project. */
export function contributionFileLabel(projectRoot: string, file: string): string {
  const rel = nodePath.relative(projectRoot, file);
  return (rel && !rel.startsWith('..') ? rel : file).split(nodePath.sep).join('/');
}

/**
 * Normalise a registry loader's issues into load failures. Only `load-failed`
 * counts: `invalid-*` / `duplicate-id` issues concern entries of a file that
 * DID load (they travel as rejections), and `missing-file` is reported by the
 * manifest checks.
 */
export function registryIssuesToLoadFailures(
  inspection: ISharkcraftInspection,
  kind: string,
  issues: readonly { readonly code?: string; readonly message: string; readonly source?: string }[],
): IContributionLoadFailure[] {
  const out: IContributionLoadFailure[] = [];
  for (const i of issues) {
    if (i.code !== 'load-failed' || !i.source) continue;
    const file = resolveIssueSource(inspection, i.source);
    const packageName = owningPack(inspection, file);
    out.push({
      file,
      kind,
      ...(packageName ? { packageName } : {}),
      message: firstLine(i.message.replace(/^(?:Failed to load \S+: |Pack \S+ \([^)]*\): )/, '')),
      via: 'registry',
    });
  }
  return out;
}

/** Scaffold-pattern loading reports failures as warning strings; lift the import failures. */
export function scaffoldWarningsToLoadFailures(
  inspection: ISharkcraftInspection,
  warnings: readonly string[],
): IContributionLoadFailure[] {
  const out: IContributionLoadFailure[] = [];
  for (const w of warnings) {
    const m = /^failed to import scaffold pattern file (.+?): ([\s\S]*)$/.exec(w);
    if (!m) continue;
    const file = nodePath.resolve(m[1]!);
    const packageName = owningPack(inspection, file);
    out.push({
      file,
      kind: 'scaffold-pattern',
      ...(packageName ? { packageName } : {}),
      message: firstLine(m[2]!),
      via: 'registry',
    });
  }
  return out;
}

/** Lift one loader's `rejected` records into THE channel's shape (absolute file, owning pack attributed). */
export function liftRejections(
  inspection: ISharkcraftInspection,
  kind: ContributionKind,
  rejected: readonly IRejectedEntry[],
  via: IContributionEntryRejection['via'] = 'registry',
): IContributionEntryRejection[] {
  return rejected.map((r) => {
    const file = nodePath.resolve(r.file);
    const packageName = owningPack(inspection, file);
    return { ...r, file, kind, ...(packageName ? { packageName } : {}), via };
  });
}

/** One registry loader, run by {@link collectRegistryOutcomes}: the kinds it answers for and how to read it. */
interface IRegistryOutcomeLoader {
  readonly kinds: readonly ContributionKind[];
  readonly run: (inspection: ISharkcraftInspection) => Promise<IRegistryOutcomes>;
}

/** Build one loader's outcome from its entries, issues and rejections. */
function outcome(
  inspection: ISharkcraftInspection,
  kind: ContributionKind,
  parts: {
    readonly issues?: readonly { readonly code?: string; readonly message: string; readonly source?: string }[];
    readonly rejected?: readonly IRejectedEntry[];
    readonly accepted?: readonly { readonly id: string; readonly file?: string; readonly packageName?: string; readonly title?: string }[];
  },
): IRegistryOutcomes {
  const accepted: IContributionAcceptedEntry[] = [];
  for (const a of parts.accepted ?? []) {
    if (!a.file) continue; // a builtin — not a contribution
    const file = resolveEntryFile(inspection, a.file, a.packageName);
    const packageName = a.packageName ?? owningPack(inspection, file);
    accepted.push({
      kind,
      file,
      ...(packageName ? { packageName } : {}),
      id: a.id,
      ...(a.title ? { title: a.title } : {}),
    });
  }
  return {
    loadFailures: registryIssuesToLoadFailures(inspection, kind, parts.issues ?? []),
    rejections: liftRejections(inspection, kind, parts.rejected ?? []),
    accepted,
  };
}

const titleOf = (v: unknown): string | undefined => {
  const t = v && typeof v === 'object' ? (v as { title?: unknown }).title : undefined;
  return typeof t === 'string' && t.length > 0 ? t : undefined;
};

/**
 * THE registry-loader table: every contribution kind a REGISTRY loads (the
 * inspection-time kinds — knowledge, rules, paths, docs, templates, pipelines,
 * presets, boundaries — report through `inspection.loaderDiagnostics`). A
 * loader-backed manifest slot missing from both is caught by the r76 census.
 */
const REGISTRY_OUTCOME_LOADERS: readonly IRegistryOutcomeLoader[] = [
  {
    kinds: [ContributionKind.Helper],
    // THE helper catalog — the list `shrk helper list` prints.
    run: async (i) => {
      const c = await listAllHelpers(i);
      return outcome(i, ContributionKind.Helper, {
        issues: c.issues,
        rejected: c.rejected,
        accepted: c.entries
          .filter((e) => e.source !== 'builtin')
          .map((e) => ({ id: e.id, file: e.sourceFile, packageName: e.packageName, title: e.description })),
      });
    },
  },
  {
    kinds: [ContributionKind.Convention],
    run: async (i) => {
      const r = await loadConventions(i);
      return outcome(i, ContributionKind.Convention, {
        issues: r.issues,
        rejected: r.rejected,
        accepted: r.entries.map((e) => ({
          id: e.convention.id,
          file: e.sourceFile,
          packageName: e.packageName,
          title: titleOf(e.convention),
        })),
      });
    },
  },
  {
    kinds: [ContributionKind.TaskRoutingHint],
    run: async (i) => {
      const r = await loadTaskRoutingHints(i);
      return outcome(i, ContributionKind.TaskRoutingHint, {
        issues: r.issues,
        rejected: r.rejected,
        accepted: r.entries.map((e) => ({ id: e.hint.id, file: e.sourceFile, packageName: e.packageName, title: titleOf(e.hint) })),
      });
    },
  },
  {
    kinds: [ContributionKind.RegistrationHint],
    run: async (i) => {
      const r = await loadRegistrationHints(i);
      return outcome(i, ContributionKind.RegistrationHint, {
        issues: r.issues,
        rejected: r.rejected,
        accepted: r.entries.map((e) => ({ id: e.hint.id, file: e.sourceFile, packageName: e.packageName, title: e.hint.title })),
      });
    },
  },
  {
    kinds: [ContributionKind.ContractTemplate],
    run: async (i) => {
      const r = await loadAllContractTemplates(i);
      return outcome(i, ContributionKind.ContractTemplate, {
        issues: r.issues,
        rejected: r.rejected,
        accepted: r.entries.map((e) => ({
          id: e.template.id,
          file: e.sourceFile,
          packageName: e.packageName,
          title: titleOf(e.template),
        })),
      });
    },
  },
  {
    kinds: [ContributionKind.MigrationProfile],
    run: async (i) => {
      const r = await loadMigrationProfiles(i);
      return outcome(i, ContributionKind.MigrationProfile, {
        issues: r.issues,
        rejected: r.rejected,
        accepted: r.entries.map((e) => ({ id: e.profile.id, file: e.sourceFile, packageName: e.packageName, title: e.profile.title })),
      });
    },
  },
  {
    kinds: [ContributionKind.ScaffoldPattern],
    run: async (i) => {
      const r = await loadScaffoldPatternsFromInspection(i);
      const base = outcome(i, ContributionKind.ScaffoldPattern, {
        rejected: r.rejected,
        accepted: r.patterns.map((p) => ({
          id: p.pattern.id,
          file: p.source.file,
          packageName: p.source.packageName,
          title: titleOf(p.pattern),
        })),
      });
      return { ...base, loadFailures: scaffoldWarningsToLoadFailures(i, r.warnings) };
    },
  },
  {
    kinds: [ContributionKind.Playbook],
    // A playbook file that failed to import is a load failure like any other
    // registry's: the same `invalid-contribution` error a broken hint file gets.
    run: async (i) => {
      const r = await loadPlaybooksWithIssues(i);
      return outcome(i, ContributionKind.Playbook, {
        issues: r.issues,
        rejected: r.rejected,
        accepted: r.playbooks.map((p) => ({ id: p.id, file: p.sourceFile, packageName: p.packageName, title: p.title })),
      });
    },
  },
  {
    kinds: [ContributionKind.Construct, ContributionKind.ConstructFacet],
    run: async (i) => {
      const r = await loadConstructsWithIssues(i);
      const constructs = outcome(i, ContributionKind.Construct, {
        issues: r.issues,
        rejected: r.rejected,
        accepted: r.constructs.map((c) => ({ id: c.id, file: c.sourceFile, packageName: c.packageName, title: c.title })),
      });
      const facets = outcome(i, ContributionKind.ConstructFacet, {
        issues: r.facetIssues,
        rejected: r.facetRejected,
        accepted: r.facets.map((f) => ({ id: f.id, file: f.file, packageName: f.packageName })),
      });
      return {
        loadFailures: [...constructs.loadFailures, ...facets.loadFailures],
        rejections: [...constructs.rejections, ...facets.rejections],
        accepted: [...constructs.accepted, ...facets.accepted],
      };
    },
  },
  {
    kinds: [ContributionKind.SearchTuning],
    run: async (i) => {
      const r = await loadSearchTuning(i);
      return outcome(i, ContributionKind.SearchTuning, {
        issues: r.issues,
        rejected: r.rejected,
        accepted: r.entries.map((e) => ({ id: e.id, file: e.sourceFile, packageName: e.packageName })),
      });
    },
  },
  {
    kinds: [ContributionKind.Decision],
    run: async (i) => {
      const r = await loadTsDecisionsWithIssues(i);
      return outcome(i, ContributionKind.Decision, {
        issues: r.issues,
        rejected: r.rejected,
        accepted: r.decisions.map((d) => ({ id: d.id, file: d.sourceFile, title: d.title })),
      });
    },
  },
  {
    kinds: [ContributionKind.Policy],
    run: async (i) => {
      const r = await loadPolicyDeclarationsWithIssues(i);
      return outcome(i, ContributionKind.Policy, {
        issues: r.issues,
        rejected: r.rejected,
        accepted: r.declarations.map((d) => ({ id: d.id, file: d.sourceFile })),
      });
    },
  },
  {
    kinds: [ContributionKind.FeedbackRule],
    run: async (i) => {
      const r = await loadFeedbackRulesWithIssues(i);
      return outcome(i, ContributionKind.FeedbackRule, { issues: r.issues, rejected: r.rejected, accepted: r.entries });
    },
  },
  {
    kinds: [ContributionKind.ContextTest, ContributionKind.AgentTest],
    run: async (i) => {
      // Loaded lazily: the test runner pulls in the task-packet stack.
      const { loadContextTestsWithIssues, loadAgentContractTestsWithIssues } = await import('./test-runner.ts');
      const [ctx, agent] = await Promise.all([loadContextTestsWithIssues(i), loadAgentContractTestsWithIssues(i)]);
      const a = outcome(i, ContributionKind.ContextTest, { issues: ctx.issues, rejected: ctx.rejected, accepted: ctx.entries });
      const b = outcome(i, ContributionKind.AgentTest, { issues: agent.issues, rejected: agent.rejected, accepted: agent.entries });
      return {
        loadFailures: [...a.loadFailures, ...b.loadFailures],
        rejections: [...a.rejections, ...b.rejections],
        accepted: [...a.accepted, ...b.accepted],
      };
    },
  },
  {
    kinds: [ContributionKind.DelegateRecipe],
    run: async (i) => {
      const r = await loadDelegateRecipesFromPacks(i.packs.validPacks ?? []);
      return outcome(i, ContributionKind.DelegateRecipe, {
        issues: r.issues,
        rejected: r.rejected,
        accepted: r.recipes.map((p) => ({ id: p.recipe.id, file: p.sourceFile, packageName: p.packageName, title: p.recipe.title })),
      });
    },
  },
  {
    kinds: [ContributionKind.FrameworkExtractor],
    run: async (i) => {
      const r = await loadFrameworkExtractorOutcomes(i);
      return outcome(i, ContributionKind.FrameworkExtractor, { issues: r.issues, rejected: r.rejected, accepted: r.accepted });
    },
  },
  {
    kinds: [
      ContributionKind.WiringRule,
      ContributionKind.Registry,
      ContributionKind.RegistrationIdiom,
      ContributionKind.PolicyRule,
      ContributionKind.ReusePrimitive,
      ContributionKind.Baseline,
      ContributionKind.GeneratedArtifact,
      // Round 13 (P3): the doc-reference plane's pack slot is declared, and the
      // seam records its outcome like every other plane's.
      ContributionKind.DocReference,
    ],
    // THE gate-plane merge seam — the same resolution every plane reader runs.
    run: async (i) => {
      const r = await resolveProjectConfig(i.projectRoot);
      if (!r.ok || !r.value.planeOutcomes) return { loadFailures: [], rejections: [], accepted: [] };
      const o = r.value.planeOutcomes;
      return {
        loadFailures: o.loadFailures.map((f) => ({
          file: f.file,
          kind: f.kind,
          packageName: f.packageName,
          message: f.message,
          via: 'registry' as const,
        })),
        rejections: [...o.rejected],
        accepted: [...o.accepted],
      };
    },
  },
];

/** Every contribution kind a registry loader answers for (the rest report through loader diagnostics). */
export const REGISTRY_BACKED_KINDS: readonly ContributionKind[] = REGISTRY_OUTCOME_LOADERS.flatMap((l) => l.kinds);

/**
 * Run the registry loaders ONCE and return what they reported: load failures,
 * rejected entries and accepted entries (each attributed to its file). With
 * `kinds`, only the loaders for those kinds run — a `list` verb asks for its
 * own kind. Every loader degrades to "nothing" on a throw, never a crash.
 */
export async function collectRegistryOutcomes(
  inspection: ISharkcraftInspection,
  options: { readonly kinds?: readonly ContributionKind[] } = {},
): Promise<IRegistryOutcomes> {
  const wanted = options.kinds;
  const loaders = wanted
    ? REGISTRY_OUTCOME_LOADERS.filter((l) => l.kinds.some((k) => wanted.includes(k)))
    : REGISTRY_OUTCOME_LOADERS;
  const results = await Promise.all(
    loaders.map(async (l) => {
      try {
        return await l.run(inspection);
      } catch {
        return null;
      }
    }),
  );
  const loadFailures: IContributionLoadFailure[] = [];
  const rejections: IContributionEntryRejection[] = [];
  const accepted: IContributionAcceptedEntry[] = [];
  for (const r of results) {
    if (!r) continue;
    loadFailures.push(...r.loadFailures);
    rejections.push(...r.rejections);
    accepted.push(...r.accepted);
  }
  return { loadFailures, rejections, accepted };
}

/**
 * Run the async registry loaders once and return their load failures. Callers
 * that already ran them (the async inventory) pass their own issues instead.
 */
export async function collectRegistryLoadFailures(
  inspection: ISharkcraftInspection,
): Promise<readonly IContributionLoadFailure[]> {
  return (await collectRegistryOutcomes(inspection)).loadFailures;
}

/**
 * Every known load failure, keyed by absolute file path. `registryFailures`
 * adds what the async registries reported (see {@link collectRegistryLoadFailures}).
 */
export function collectContributionLoadFailures(
  inspection: ISharkcraftInspection,
  registryFailures: readonly IContributionLoadFailure[] = [],
): ReadonlyMap<string, IContributionLoadFailure> {
  const out = new Map<string, IContributionLoadFailure>();
  for (const d of inspection.loaderDiagnostics ?? []) {
    const failed =
      d.status === 'failed' ||
      d.status === 'timeout' ||
      (d.status === 'cached-skip' && d.cachedStatus !== undefined && d.cachedStatus !== 'ok');
    if (!failed) continue;
    const file = nodePath.resolve(d.filePath);
    if (out.has(file)) continue;
    const packageName = d.packName ?? owningPack(inspection, file);
    out.set(file, {
      file,
      kind: d.kind,
      ...(packageName ? { packageName } : {}),
      message: firstLine(d.errorMessage ?? `loader ${d.status}`),
      via: 'loader-diagnostics',
    });
  }
  for (const f of registryFailures) if (!out.has(f.file)) out.set(f.file, f);
  return out;
}

/**
 * An inspection-time loader's asset kind → the contribution kind its
 * rejections belong to. A `Record` over {@link LoaderAssetKind}, so a loader
 * kind added without a row is a compile error.
 */
export const LOADER_ASSET_KIND_CONTRIBUTION: Readonly<Record<LoaderAssetKind, ContributionKind>> = {
  knowledge: ContributionKind.Knowledge,
  rules: ContributionKind.Rule,
  paths: ContributionKind.Path,
  docs: ContributionKind.Docs,
  templates: ContributionKind.Template,
  pipelines: ContributionKind.Pipeline,
  presets: ContributionKind.Preset,
  boundaries: ContributionKind.Boundary,
};

const CONTRIBUTION_KIND_VALUES: ReadonlySet<string> = new Set(Object.values(ContributionKind));

/**
 * THE contribution kind of a loader's `kind` (round 12 review, R12-X4): a load
 * failure's / diagnostic's `kind` names the loader that tried the file — the
 * plural asset kind for the inspection-time loaders (`rules`, `templates`, …),
 * the contribution kind itself for the registry loaders (`helper`,
 * `convention`, …). Every reader maps through here — the rejection channel,
 * `collectKindOutcomes`, the contributions report's rows and `packs
 * contributions --kind` — so a printed row and the exit read one table.
 * `undefined` for a kind no loader reports.
 */
export function contributionKindOfLoader(kind: string): ContributionKind | undefined {
  if (CONTRIBUTION_KIND_VALUES.has(kind)) return kind as ContributionKind;
  return Object.prototype.hasOwnProperty.call(LOADER_ASSET_KIND_CONTRIBUTION, kind)
    ? LOADER_ASSET_KIND_CONTRIBUTION[kind as LoaderAssetKind]
    : undefined;
}

/**
 * THE rejection channel (round 12, 12.1): every rejected contribution entry —
 * the inspection-time loaders' (`loaderDiagnostics[].rejected`) plus what the
 * registry loaders reported (`registryRejections`, from
 * {@link collectRegistryOutcomes}) — deduplicated and sorted by file then
 * position. Every surface reads this list; none re-derives it.
 */
export function collectContributionRejections(
  inspection: ISharkcraftInspection,
  registryRejections: readonly IContributionEntryRejection[] = [],
): readonly IContributionEntryRejection[] {
  const out: IContributionEntryRejection[] = [];
  const seen = new Set<string>();
  const add = (r: IContributionEntryRejection): void => {
    const key = `${r.kind}|${r.file}|${r.exportName ?? ''}|${r.index}|${r.cause}|${r.entryId ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(r);
  };
  for (const d of inspection.loaderDiagnostics ?? []) {
    if (!d.rejected || d.rejected.length === 0) continue;
    const kind = contributionKindOfLoader(d.kind) ?? ContributionKind.Knowledge;
    for (const r of liftRejections(inspection, kind, d.rejected, 'loader-diagnostics')) {
      add(d.packName && !r.packageName ? { ...r, packageName: d.packName } : r);
    }
  }
  for (const r of registryRejections) add({ ...r, file: nodePath.resolve(r.file) });
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.index - b.index);
}

/**
 * The rejections AND load failures of `kinds` only, from ONE run of just the
 * loaders those kinds need — what a `list` verb reads for its `⚠` note. A file
 * that never loaded drops every entry it declares, so it is said as loudly as
 * a refused entry (round 12 review, A-4: `conventions list` printed "(none —
 * contribute via … sharkcraft/conventions.ts)" over the very file that failed).
 */
export async function collectKindOutcomes(
  inspection: ISharkcraftInspection,
  kinds: readonly ContributionKind[],
): Promise<IKindOutcomes> {
  const registryKinds = kinds.filter((k) => REGISTRY_BACKED_KINDS.includes(k));
  const registry =
    registryKinds.length > 0 ? await collectRegistryOutcomes(inspection, { kinds: registryKinds }) : undefined;
  const rejections = collectContributionRejections(inspection, registry?.rejections ?? []).filter((r) =>
    kinds.includes(r.kind),
  );
  // A failure's `kind` is the loader's: the plural asset kind for the
  // inspection-time loaders, the contribution kind for the registry loaders.
  const loadFailures = [...collectContributionLoadFailures(inspection, registry?.loadFailures ?? []).values()]
    .filter((f) => {
      const kind = contributionKindOfLoader(f.kind);
      return kind !== undefined && kinds.includes(kind);
    })
    .sort((a, b) => a.file.localeCompare(b.file));
  return { rejections, loadFailures };
}

/** The rejections of `kinds` only — {@link collectKindOutcomes} without the load failures. */
export async function collectKindRejections(
  inspection: ISharkcraftInspection,
  kinds: readonly ContributionKind[],
): Promise<readonly IContributionEntryRejection[]> {
  return (await collectKindOutcomes(inspection, kinds)).rejections;
}

/**
 * THE one wording of a rejected entry, used on every surface:
 * `'conv.b' (default[8]) — severity: severity must be one of: info, warning, error (got undefined)`.
 */
export function formatEntryRejection(r: Pick<IRejectedEntry, 'entryId' | 'index' | 'exportName' | 'reasons'>): string {
  const who = r.entryId !== undefined ? `'${r.entryId}'` : '(no id)';
  const where = r.index >= 0 ? `${r.exportName ?? ''}[${r.index}]` : (r.exportName ?? 'default');
  return `${who} (${where}) — ${r.reasons.join('; ')}`;
}
