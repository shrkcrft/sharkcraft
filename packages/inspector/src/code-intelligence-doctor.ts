import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as nodePath from 'node:path';
import { DoctorSeverity, type IDoctorCheck } from './doctor-result.ts';

/**
 * Doctor checks for the code-intelligence layer (`@shrkcrft/graph`,
 * `rule-graph`, `api-surface-diff`, `quality-gates`, `migrate`, ...).
 *
 * Inspector deliberately does NOT depend on those packages — they sit
 * below it in the layer order, and importing them would tie inspector to
 * the optional code-intelligence install. Instead the checks read the
 * stable on-disk state files each package writes under `.sharkcraft/`,
 * with locally-redeclared minimal JSON shapes. The redeclared shapes are
 * a subset of the canonical schemas; if a future schema bump removes a
 * field we use we fall back to defaults rather than crashing.
 *
 * Every finding here is bucketed under `category: 'code-intelligence'`
 * so a downstream `--hide code-intelligence` mutes the whole section.
 */

interface IGraphManifestLike {
  schema?: string;
  lastIndexedAt?: string;
  filesIndexed?: number;
  nodesByKind?: Readonly<Record<string, number>>;
  edgesByKind?: Readonly<Record<string, number>>;
  cycleCount?: number;
  largestCycleSize?: number;
  filesInCycles?: number;
  unresolvedImportCount?: number;
  filesWithUnresolvedImports?: number;
  unresolvedImportSamples?: readonly string[];
}

interface IBridgeManifestLike {
  schema?: string;
  lastBuiltAt?: string;
  nodesByKind?: Readonly<Record<string, number>>;
  edgesByKind?: Readonly<Record<string, number>>;
  sourceCounts?: Readonly<Record<string, number>>;
  filesTotal?: number;
  filesCoveredByRules?: number;
  filesUncoveredByRules?: number;
}

interface IApiSurfaceCacheLike {
  schema?: string;
  generatedAt?: string;
  files?: Readonly<Record<string, unknown>>;
}

interface IQualityGateReportLike {
  schema?: string;
  overall?: 'pass' | 'fail' | 'warn' | 'skipped';
  startedAt?: string;
  counts?: Readonly<Record<string, number>>;
  gates?: ReadonlyArray<{ id?: string; status?: string }>;
}

interface IMigrationStepLike {
  index?: number;
  id?: string;
  status?: 'pending' | 'planned' | 'applied' | 'failed' | 'skipped';
}

interface IMigrationRunLike {
  schema?: string;
  migration?: { id?: string; title?: string };
  overall?: 'pass' | 'fail' | 'skipped';
  startedAt?: string;
  steps?: readonly IMigrationStepLike[];
}

interface IArchSnapshotLike {
  schema?: string;
  generatedAt?: string;
  filesAnalyzed?: number;
  countsBySeverity?: Readonly<Record<string, number>>;
  violationIds?: readonly string[];
}

interface IImpactRunLike {
  schema?: string;
  generatedAt?: string;
  inputKind?: 'files' | 'symbol' | 'gitref';
  inputSummary?: string;
  risk?: 'low' | 'medium' | 'high' | 'critical';
  directDependentCount?: number;
  transitiveDependentCount?: number;
  affectedPackageCount?: number;
  likelyTestCount?: number;
  publicApiTouched?: boolean;
  validationScope?: readonly string[];
}

interface IFrameworkManifestLike {
  schema?: string;
  lastBuiltAt?: string;
  countsByFramework?: Readonly<Record<string, number>>;
  countsBySubtype?: Readonly<Record<string, number>>;
  frameworks?: readonly string[];
}

interface IPatternRegistryEntryLike {
  id?: string;
  lastValidatedAt?: string;
  lastValidationError?: string;
  pattern?: { kind?: string };
}

interface IPatternRegistryLike {
  schema?: string;
  patterns?: readonly IPatternRegistryEntryLike[];
}

interface IIntentBenchmarkRunLike {
  schema?: string;
  total?: number;
  passed?: number;
  failed?: number;
  accuracy?: number;
  ranAt?: string;
  cases?: readonly { passed?: boolean; expected?: string; actual?: string; task?: string }[];
}

const STALE_THRESHOLD_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const CATEGORY = 'code-intelligence';

function readJsonFile<T>(absPath: string): T | undefined {
  if (!existsSync(absPath)) return undefined;
  try {
    return JSON.parse(readFileSync(absPath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function ageDays(iso: string | undefined, nowMs: number): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  return (nowMs - t) / DAY_MS;
}

function fmtAge(days: number): string {
  if (days < 1 / 24) {
    const minutes = Math.max(1, Math.round(days * 24 * 60));
    return `${minutes}m ago`;
  }
  if (days < 1) {
    const hours = Math.max(1, Math.round(days * 24));
    return `${hours}h ago`;
  }
  return `${Math.round(days)}d ago`;
}

function sumValues(rec: Readonly<Record<string, number>> | undefined): number {
  if (!rec) return 0;
  let total = 0;
  for (const v of Object.values(rec)) {
    if (typeof v === 'number' && Number.isFinite(v)) total += v;
  }
  return total;
}

export interface ICodeIntelligenceDoctorOptions {
  /**
   * Overrides `Date.now()`. Used by tests to make age computations
   * deterministic without touching the system clock.
   */
  nowMs?: number;
  /**
   * Override the stale-data threshold (days). Default 7. Tests use this
   * to flip a fresh fixture into "stale" without changing mtime.
   */
  staleThresholdDays?: number;
}

/**
 * Read every code-intelligence package's persisted state and produce a
 * compact set of doctor findings. The function is sync (matches the
 * rest of `runDoctor`) and silent when no state is present (e.g. the
 * user has never run `shrk graph index`).
 */
export function buildCodeIntelligenceChecks(
  projectRoot: string,
  options: ICodeIntelligenceDoctorOptions = {},
): IDoctorCheck[] {
  const nowMs = options.nowMs ?? Date.now();
  const staleDays = options.staleThresholdDays ?? STALE_THRESHOLD_DAYS;
  const checks: IDoctorCheck[] = [];

  checks.push(...graphChecks(projectRoot, nowMs, staleDays));
  checks.push(...ruleGraphChecks(projectRoot, nowMs, staleDays));
  checks.push(...apiSurfaceChecks(projectRoot, nowMs, staleDays));
  checks.push(...qualityGateChecks(projectRoot, nowMs, staleDays));
  checks.push(...migrationChecks(projectRoot));
  checks.push(...architectureChecks(projectRoot, nowMs, staleDays));
  checks.push(...impactRunChecks(projectRoot, nowMs, staleDays));
  checks.push(...frameworkChecks(projectRoot, nowMs, staleDays));
  checks.push(...structuralRegistryChecks(projectRoot));
  checks.push(...contextPlannerChecks(projectRoot, nowMs, staleDays));
  checks.push(...schemaCompatChecks(projectRoot));

  return checks;
}

/**
 * Expected on-disk schema strings, keyed by `.sharkcraft/<rel>` store
 * file. Used by the schema-compat check to detect when a stored payload
 * was written by an older (incompatible) version of a package. When a
 * package bumps to a new major schema we add a row here AND the
 * matching reader on the producing side; the doctor flags any tree
 * that still has the older version.
 */
const EXPECTED_SCHEMAS: ReadonlyArray<{ rel: string; expected: string; package: string }> = [
  { rel: 'graph/meta.json', expected: 'sharkcraft.graph/v1', package: '@shrkcrft/graph' },
  { rel: 'bridge/meta.json', expected: 'sharkcraft.rule-graph/v1', package: '@shrkcrft/rule-graph' },
  { rel: 'api-surface/signatures.json', expected: 'sharkcraft.api-surface-cache/v1', package: '@shrkcrft/api-surface-diff' },
  { rel: 'quality-gates/last.json', expected: 'sharkcraft.quality-gate-report/v1', package: '@shrkcrft/quality-gates' },
  { rel: 'framework/meta.json', expected: 'sharkcraft.framework/v1', package: '@shrkcrft/framework-scanners' },
  { rel: 'architecture/baseline.json', expected: 'sharkcraft.architecture-snapshot/v1', package: '@shrkcrft/architecture-guard' },
  { rel: 'architecture/last.json', expected: 'sharkcraft.architecture-snapshot/v1', package: '@shrkcrft/architecture-guard' },
  { rel: 'impact/last.json', expected: 'sharkcraft.impact-run/v1', package: '@shrkcrft/impact-engine' },
  { rel: 'impact/baseline.json', expected: 'sharkcraft.impact-run/v1', package: '@shrkcrft/impact-engine' },
  { rel: 'structural/patterns.json', expected: 'sharkcraft.structural-pattern-registry/v1', package: '@shrkcrft/structural-search' },
  { rel: 'context-planner/intent-benchmark.json', expected: 'sharkcraft.intent-benchmark/v1', package: '@shrkcrft/context-planner' },
];

function graphChecks(
  projectRoot: string,
  nowMs: number,
  staleDays: number,
): IDoctorCheck[] {
  const metaPath = nodePath.join(projectRoot, '.sharkcraft', 'graph', 'meta.json');
  if (!existsSync(metaPath)) {
    return [
      {
        id: 'code-intelligence-graph',
        title: 'Code-intelligence graph index',
        severity: DoctorSeverity.Info,
        category: CATEGORY,
        message:
          'No code graph indexed yet — `shrk impact`, `shrk graph callers`, and context packs fall back to slower scans.',
        fix: 'Run `shrk graph index` once to enable code-intelligence queries.',
      },
    ];
  }

  const manifest = readJsonFile<IGraphManifestLike>(metaPath);
  if (!manifest) {
    return [
      {
        id: 'code-intelligence-graph',
        title: 'Code-intelligence graph index',
        severity: DoctorSeverity.Warning,
        category: CATEGORY,
        message: '.sharkcraft/graph/meta.json exists but is not valid JSON.',
        fix: 'Rebuild with `shrk graph index --full`.',
        whyThisMatters:
          'Without a usable graph manifest the dependent surfaces (impact, callers, context-planner) silently degrade.',
      },
    ];
  }

  const days = ageDays(manifest.lastIndexedAt, nowMs);
  const stale = days !== undefined && days > staleDays;
  const ageStr = days !== undefined ? ` (${fmtAge(days)})` : '';
  const counts = `${manifest.filesIndexed ?? 0} files, ${sumValues(
    manifest.nodesByKind,
  )} nodes, ${sumValues(manifest.edgesByKind)} edges`;
  const cycleTag =
    typeof manifest.cycleCount === 'number' && manifest.cycleCount > 0
      ? `, ${manifest.cycleCount} cycle${manifest.cycleCount === 1 ? '' : 's'}` +
        (typeof manifest.largestCycleSize === 'number' && manifest.largestCycleSize > 0
          ? ` (largest ${manifest.largestCycleSize})`
          : '')
      : '';

  const out: IDoctorCheck[] = [];
  if (stale) {
    out.push({
      id: 'code-intelligence-graph',
      title: 'Code-intelligence graph index',
      severity: DoctorSeverity.Warning,
      advisory: true,
      category: CATEGORY,
      message: `Graph index is stale${ageStr} — ${counts}${cycleTag}.`,
      fix: 'Re-index with `shrk graph index --changed` (or `--full`).',
      whyThisMatters:
        'Stale code graph makes `shrk impact`, `shrk graph callers`, and context packs return outdated answers.',
    });
  } else {
    out.push({
      id: 'code-intelligence-graph',
      title: 'Code-intelligence graph index',
      severity: DoctorSeverity.Ok,
      category: CATEGORY,
      message: `Graph index fresh${ageStr} — ${counts}${cycleTag}.`,
    });
  }
  // Cycles ≥ a heuristic threshold of 5 (or any 3+-file cycle) become
  // an advisory hint, so the doctor surfaces a refactor target rather
  // than only the running count. Boundary on >=3 catches the harder
  // refactors; small 2-file cycles often come and go and would otherwise
  // be noisy.
  const largeCycle =
    typeof manifest.largestCycleSize === 'number' && manifest.largestCycleSize >= 3;
  const manyCycles =
    typeof manifest.cycleCount === 'number' && manifest.cycleCount >= 5;
  if (largeCycle || manyCycles) {
    out.push({
      id: 'code-intelligence-graph-cycles',
      title: 'Code-intelligence graph cycles',
      severity: DoctorSeverity.Warning,
      advisory: true,
      category: CATEGORY,
      message:
        `${manifest.cycleCount ?? 0} import cycle(s) in the graph` +
        (manifest.largestCycleSize ? ` (largest spans ${manifest.largestCycleSize} files)` : '') +
        (manifest.filesInCycles ? `, ${manifest.filesInCycles} file(s) in cycles.` : '.'),
      fix: 'List with `shrk graph cycles` or breakdown with `shrk arch check`.',
      whyThisMatters:
        'Import cycles freeze refactors and make `shrk impact` overestimate blast radius (everything in the cycle becomes reachable from everything else).',
    });
  }

  // Unresolved imports — high-signal DX warning. The indexer emits a
  // `file: → unresolved:<spec>` edge for every import the resolver
  // couldn't match against an on-disk file. Almost always a typo,
  // missing dependency, or a path-alias that was renamed without
  // updating the importer.
  if (
    typeof manifest.unresolvedImportCount === 'number' &&
    manifest.unresolvedImportCount > 0
  ) {
    const samples = manifest.unresolvedImportSamples ?? [];
    const sampleStr =
      samples.length > 0
        ? ` — first ${Math.min(samples.length, 3)}: ${samples
            .slice(0, 3)
            .map((s) => JSON.stringify(s))
            .join(', ')}${samples.length > 3 ? '…' : ''}`
        : '';
    out.push({
      id: 'code-intelligence-graph-unresolved',
      title: 'Code-intelligence unresolved imports',
      severity: DoctorSeverity.Warning,
      category: CATEGORY,
      message:
        `${manifest.unresolvedImportCount} unresolved import(s) across ` +
        `${manifest.filesWithUnresolvedImports ?? 0} file(s)${sampleStr}.`,
      fix: 'Inspect with `shrk graph search --kind file --has-unresolved-imports` (or grep for the sample specifiers). Likely causes: typo in path, deleted file still imported, alias renamed without updating callers.',
      whyThisMatters:
        "Unresolved imports leak past the typechecker for path-alias / dynamic-import paths and cause `shrk impact` to under-count dependents (no edge exists from the broken import to the intended target).",
    });
  }
  return out;
}

function ruleGraphChecks(
  projectRoot: string,
  nowMs: number,
  staleDays: number,
): IDoctorCheck[] {
  const metaPath = nodePath.join(projectRoot, '.sharkcraft', 'bridge', 'meta.json');
  if (!existsSync(metaPath)) {
    // Silent when no bridge has been built. The bridge is downstream of
    // `shrk graph index`; the graph check above is enough of a nudge.
    return [];
  }
  const manifest = readJsonFile<IBridgeManifestLike>(metaPath);
  if (!manifest) {
    return [
      {
        id: 'code-intelligence-rule-graph',
        title: 'Code-intelligence rule-graph bridge',
        severity: DoctorSeverity.Warning,
        category: CATEGORY,
        message: '.sharkcraft/bridge/meta.json exists but is not valid JSON.',
        fix: 'Rebuild with `shrk graph index`.',
      },
    ];
  }

  const days = ageDays(manifest.lastBuiltAt, nowMs);
  const stale = days !== undefined && days > staleDays;
  const ageStr = days !== undefined ? ` (${fmtAge(days)})` : '';
  const counts = `${sumValues(manifest.nodesByKind)} bridge nodes, ${sumValues(
    manifest.edgesByKind,
  )} edges`;
  const out: IDoctorCheck[] = [];
  if (stale) {
    out.push({
      id: 'code-intelligence-rule-graph',
      title: 'Code-intelligence rule-graph bridge',
      severity: DoctorSeverity.Warning,
      advisory: true,
      category: CATEGORY,
      message: `Rule-graph bridge is stale${ageStr} — ${counts}.`,
      fix: 'Re-build with `shrk graph index` (bridges build alongside graph).',
      whyThisMatters:
        'A stale bridge means `shrk rules where applies-to <file>` and rule-aware impact answers may miss recent edits.',
    });
  } else {
    out.push({
      id: 'code-intelligence-rule-graph',
      title: 'Code-intelligence rule-graph bridge',
      severity: DoctorSeverity.Ok,
      category: CATEGORY,
      message: `Rule-graph bridge fresh${ageStr} — ${counts}.`,
    });
  }
  // §3.2 exit criterion: bridge coverage gap. Surface when more than
  // half of indexed files have no applicable rule edge. We deliberately
  // skip the case where bridge coverage fields are absent (forward-
  // compat with older manifest writers) — they were added in 2026-05.
  const total = manifest.filesTotal;
  const uncovered = manifest.filesUncoveredByRules;
  const covered = manifest.filesCoveredByRules;
  if (
    typeof total === 'number' &&
    total > 0 &&
    typeof uncovered === 'number' &&
    typeof covered === 'number'
  ) {
    const ratio = uncovered / total;
    const pct = Math.round(ratio * 100);
    const baseMsg = `${covered}/${total} files covered by rules (${100 - pct}%).`;
    if (ratio > 0.5) {
      out.push({
        id: 'code-intelligence-rule-coverage',
        title: 'Code-intelligence rule coverage',
        severity: DoctorSeverity.Warning,
        advisory: true,
        category: CATEGORY,
        message: `${baseMsg} ${uncovered} file(s) have no applicable rule.`,
        fix: 'Inspect with `shrk rules where applies-to <file>` and either broaden a rule\'s `appliesTo` / boundary `from`, or accept the gap.',
        whyThisMatters:
          'Files with no applicable rule are invisible to rule-aware impact, validation hints, and agent context packs. A growing coverage gap usually means the rule registry is drifting behind the codebase.',
      });
    } else {
      out.push({
        id: 'code-intelligence-rule-coverage',
        title: 'Code-intelligence rule coverage',
        severity: DoctorSeverity.Ok,
        category: CATEGORY,
        message: baseMsg,
      });
    }
  }
  return out;
}

function apiSurfaceChecks(
  projectRoot: string,
  nowMs: number,
  staleDays: number,
): IDoctorCheck[] {
  const cachePath = nodePath.join(
    projectRoot,
    '.sharkcraft',
    'api-surface',
    'signatures.json',
  );
  if (!existsSync(cachePath)) {
    return [];
  }
  const cache = readJsonFile<IApiSurfaceCacheLike>(cachePath);
  if (!cache) {
    return [
      {
        id: 'code-intelligence-api-surface',
        title: 'API surface signature cache',
        severity: DoctorSeverity.Info,
        category: CATEGORY,
        message:
          '.sharkcraft/api-surface/signatures.json exists but is not valid JSON. Next `shrk api-diff --with-signatures` will rebuild it.',
      },
    ];
  }
  const days = ageDays(cache.generatedAt, nowMs);
  const stale = days !== undefined && days > staleDays;
  const ageStr = days !== undefined ? ` (${fmtAge(days)})` : '';
  const fileCount = cache.files ? Object.keys(cache.files).length : 0;
  return [
    {
      id: 'code-intelligence-api-surface',
      title: 'API surface signature cache',
      severity: stale ? DoctorSeverity.Warning : DoctorSeverity.Ok,
      advisory: stale,
      category: CATEGORY,
      message: stale
        ? `API surface cache stale${ageStr} — ${fileCount} files cached.`
        : `API surface cache fresh${ageStr} — ${fileCount} files cached.`,
      ...(stale
        ? {
            fix: 'Refresh with `shrk api-diff --with-signatures` next time you diff a release.',
            whyThisMatters:
              'Stale signatures make `shrk api-diff` miss real signature-changed findings until the cache is rebuilt.',
          }
        : {}),
    },
  ];
}

function qualityGateChecks(
  projectRoot: string,
  nowMs: number,
  staleDays: number,
): IDoctorCheck[] {
  const reportPath = nodePath.join(
    projectRoot,
    '.sharkcraft',
    'quality-gates',
    'last.json',
  );
  if (!existsSync(reportPath)) {
    return [];
  }
  const report = readJsonFile<IQualityGateReportLike>(reportPath);
  if (!report) {
    return [
      {
        id: 'code-intelligence-quality-gate',
        title: 'Quality gate (last run)',
        severity: DoctorSeverity.Info,
        category: CATEGORY,
        message:
          '.sharkcraft/quality-gates/last.json exists but is not valid JSON. Re-run `shrk gate`.',
      },
    ];
  }
  const days = ageDays(report.startedAt, nowMs);
  const ageStr = days !== undefined ? ` ${fmtAge(days)}` : '';
  const stale = days !== undefined && days > staleDays;
  const status = report.overall ?? 'unknown';
  const failingGates = (report.gates ?? [])
    .filter((g) => g.status === 'fail')
    .map((g) => g.id ?? '?');

  if (status === 'pass') {
    return [
      {
        id: 'code-intelligence-quality-gate',
        title: 'Quality gate (last run)',
        severity: DoctorSeverity.Ok,
        category: CATEGORY,
        message: `Last gate pass${ageStr}.`,
      },
    ];
  }
  if (status === 'fail') {
    const failMsg =
      failingGates.length > 0
        ? `Last gate FAIL${ageStr} — ${failingGates.join(', ')}.`
        : `Last gate FAIL${ageStr}.`;
    // An old FAIL is stale maintenance, not a verified current regression:
    // age it out into a folded advisory that nudges a re-run instead of a
    // hard Warning that masks the (now-unknown) state of the tree. A fresh
    // FAIL stays loud. Mirrors the stale handling in apiSurfaceChecks /
    // architectureChecks so the whole code-intelligence section is consistent.
    if (stale) {
      return [
        {
          id: 'code-intelligence-quality-gate',
          title: 'Quality gate (last run)',
          severity: DoctorSeverity.Info,
          advisory: true,
          category: CATEGORY,
          message: `${failMsg} Stale (>${staleDays}d) — may not reflect the current tree.`,
          fix: 'Re-run `shrk gate` to refresh.',
        },
      ];
    }
    return [
      {
        id: 'code-intelligence-quality-gate',
        title: 'Quality gate (last run)',
        severity: DoctorSeverity.Warning,
        category: CATEGORY,
        message: failMsg,
        fix: 'Re-run with `shrk gate` and address the failing gate(s).',
        whyThisMatters:
          'The quality gate is the one-shot pass/fail the dashboard and CI agents trust — leaving it red hides real regressions.',
      },
    ];
  }
  // warn / skipped / unknown
  return [
    {
      id: 'code-intelligence-quality-gate',
      title: 'Quality gate (last run)',
      severity: DoctorSeverity.Info,
      advisory: true,
      category: CATEGORY,
      message: `Last gate ${status}${ageStr}.`,
    },
  ];
}

function architectureChecks(
  projectRoot: string,
  nowMs: number,
  staleDays: number,
): IDoctorCheck[] {
  const archDir = nodePath.join(projectRoot, '.sharkcraft', 'architecture');
  const baselinePath = nodePath.join(archDir, 'baseline.json');
  const lastPath = nodePath.join(archDir, 'last.json');
  const hasBaseline = existsSync(baselinePath);
  const hasLast = existsSync(lastPath);
  if (!hasBaseline && !hasLast) return [];

  const baseline = hasBaseline
    ? readJsonFile<IArchSnapshotLike>(baselinePath)
    : undefined;
  const last = hasLast ? readJsonFile<IArchSnapshotLike>(lastPath) : undefined;

  // Treat "last present, baseline absent" as a soft hint to freeze a
  // baseline so future regressions are caught.
  if (hasLast && !hasBaseline) {
    const lastDays = ageDays(last?.generatedAt, nowMs);
    const ageStr = lastDays !== undefined ? ` (${fmtAge(lastDays)})` : '';
    const errCount = last?.countsBySeverity?.['error'] ?? 0;
    const warnCount = last?.countsBySeverity?.['warning'] ?? 0;
    return [
      {
        id: 'code-intelligence-architecture',
        title: 'Architecture baseline',
        severity: DoctorSeverity.Info,
        category: CATEGORY,
        message: `No baseline frozen. Last arch run${ageStr}: ${errCount} error, ${warnCount} warning.`,
        fix: 'Freeze a baseline with `shrk arch baseline write` so doctor surfaces regressions.',
      },
    ];
  }

  // Baseline present but no last run — surface as info pointing at the
  // command that fills the gap.
  if (hasBaseline && !hasLast) {
    return [
      {
        id: 'code-intelligence-architecture',
        title: 'Architecture baseline',
        severity: DoctorSeverity.Info,
        category: CATEGORY,
        message:
          'Architecture baseline present, but no recent arch run to compare against.',
        fix: 'Run `shrk arch check` to refresh `.sharkcraft/architecture/last.json`.',
      },
    ];
  }

  if (!baseline || !last) {
    return [
      {
        id: 'code-intelligence-architecture',
        title: 'Architecture baseline',
        severity: DoctorSeverity.Warning,
        category: CATEGORY,
        message: '.sharkcraft/architecture/{baseline,last}.json could not be read.',
        fix: 'Re-freeze with `shrk arch baseline write`.',
      },
    ];
  }

  const baseIds = new Set(baseline.violationIds ?? []);
  const lastIds = new Set(last.violationIds ?? []);
  let newCount = 0;
  let fixedCount = 0;
  const newSample: string[] = [];
  for (const id of lastIds) {
    if (!baseIds.has(id)) {
      newCount += 1;
      if (newSample.length < 3) newSample.push(id);
    }
  }
  for (const id of baseIds) if (!lastIds.has(id)) fixedCount += 1;
  const lastDays = ageDays(last.generatedAt, nowMs);
  const lastStale = lastDays !== undefined && lastDays > staleDays;
  const errDelta =
    (last.countsBySeverity?.['error'] ?? 0) -
    (baseline.countsBySeverity?.['error'] ?? 0);
  const warnDelta =
    (last.countsBySeverity?.['warning'] ?? 0) -
    (baseline.countsBySeverity?.['warning'] ?? 0);

  if (newCount === 0 && errDelta <= 0 && warnDelta <= 0) {
    return [
      {
        id: 'code-intelligence-architecture',
        title: 'Architecture baseline',
        severity: DoctorSeverity.Ok,
        category: CATEGORY,
        message:
          `Within baseline — error ${errDelta}, warning ${warnDelta}` +
          (fixedCount > 0 ? `, ${fixedCount} fixed since baseline.` : '.') +
          (lastStale ? ` (last run ${fmtAge(lastDays!)} — stale).` : ''),
        ...(lastStale
          ? {
              fix: 'Refresh with `shrk arch check`.',
            }
          : {}),
      },
    ];
  }

  return [
    {
      id: 'code-intelligence-architecture',
      title: 'Architecture baseline',
      severity: DoctorSeverity.Warning,
      category: CATEGORY,
      message:
        `${newCount} new arch violation(s) since baseline` +
        (newSample.length > 0 ? ` — ${newSample.join(', ')}${newCount > newSample.length ? '…' : ''}` : '') +
        ` (error ${errDelta >= 0 ? '+' : ''}${errDelta}, warning ${warnDelta >= 0 ? '+' : ''}${warnDelta}).`,
      fix: 'Inspect with `shrk arch check`. If the new violations are intentional, re-freeze with `shrk arch baseline write`.',
      whyThisMatters:
        'The baseline lets the doctor catch architecture regressions the moment they appear, rather than waiting for someone to scroll through `shrk arch check` output.',
    },
  ];
}

function migrationChecks(projectRoot: string): IDoctorCheck[] {
  const dir = nodePath.join(projectRoot, '.sharkcraft', 'migrations');
  if (!existsSync(dir)) return [];

  let entries: string[] = [];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith('.state.json'));
  } catch {
    return [];
  }

  type Failed = { id: string; failedStep?: string };
  const failed: Failed[] = [];
  for (const entry of entries) {
    const report = readJsonFile<IMigrationRunLike>(nodePath.join(dir, entry));
    if (!report) continue;
    if (report.overall !== 'fail') continue;
    const failedStep = (report.steps ?? []).find((s) => s.status === 'failed');
    const id = report.migration?.id ?? entry.replace(/\.state\.json$/, '');
    failed.push({
      id,
      ...(failedStep?.id ? { failedStep: failedStep.id } : {}),
    });
  }

  if (failed.length === 0) return [];

  const first = failed[0]!;
  const head = failed
    .slice(0, 3)
    .map((f) => f.id + (f.failedStep ? ` @ ${f.failedStep}` : ''))
    .join(', ');
  const tail = failed.length > 3 ? '…' : '';
  return [
    {
      id: 'code-intelligence-migrations',
      title: 'Code-intelligence migrations',
      severity: DoctorSeverity.Warning,
      category: CATEGORY,
      message: `${failed.length} failed migration checkpoint(s) on disk: ${head}${tail}`,
      fix: `Resume with \`shrk migrate resume ${first.id}\` (or \`shrk migrate prune --include-failed\` to discard).`,
      whyThisMatters:
        "Failed migration checkpoints persist between runs so the agent or human can resume them. Doctor flags them so they don't linger silently.",
    },
  ];
}

function impactRunChecks(
  projectRoot: string,
  nowMs: number,
  staleDays: number,
): IDoctorCheck[] {
  const reportPath = nodePath.join(projectRoot, '.sharkcraft', 'impact', 'last.json');
  const baselinePath = nodePath.join(projectRoot, '.sharkcraft', 'impact', 'baseline.json');
  const baselineChecks = impactBaselineCheck(projectRoot, reportPath, baselinePath, nowMs);
  if (!existsSync(reportPath)) return baselineChecks;
  const report = readJsonFile<IImpactRunLike>(reportPath);
  if (!report) {
    return [
      {
        id: 'code-intelligence-impact',
        title: 'Code-intelligence impact (last run)',
        severity: DoctorSeverity.Info,
        category: CATEGORY,
        message: '.sharkcraft/impact/last.json exists but is not valid JSON. Next `shrk impact --via-graph` will overwrite it.',
      },
    ];
  }
  const days = ageDays(report.generatedAt, nowMs);
  const ageStr = days !== undefined ? ` ${fmtAge(days)}` : '';
  const stale = days !== undefined && days > staleDays;
  const risk = report.risk ?? 'low';
  const direct = report.directDependentCount ?? 0;
  const transitive = report.transitiveDependentCount ?? 0;
  const pkgs = report.affectedPackageCount ?? 0;
  const tests = report.likelyTestCount ?? 0;
  const input = report.inputSummary ?? '(unknown input)';

  // High-risk + recent → real warning. low/medium → OK with summary.
  // Anything stale → advisory, since the impact is from an old code
  // state and may have decayed.
  if (risk === 'high' || risk === 'critical') {
    return [
      {
        id: 'code-intelligence-impact',
        title: 'Code-intelligence impact (last run)',
        severity: DoctorSeverity.Warning,
        ...(stale ? { advisory: true } : {}),
        category: CATEGORY,
        message:
          `Last impact (${risk}) on ${input}${ageStr}: ${direct} direct + ${transitive} transitive across ${pkgs} package(s), ${tests} test(s) recommended` +
          (report.publicApiTouched ? '. Public API touched.' : '.'),
        fix: 'Re-run `shrk impact --via-graph` if stale, or follow the `validationScope` commands from the v3 report.',
        whyThisMatters:
          'High-risk impact analyses are the load-bearing signal for `shrk gate` and PR review. A stale or never-acknowledged high-risk run usually means tests + reviews are missing.',
      },
      ...baselineChecks,
    ];
  }
  return [
    {
      id: 'code-intelligence-impact',
      title: 'Code-intelligence impact (last run)',
      severity: stale ? DoctorSeverity.Info : DoctorSeverity.Ok,
      ...(stale ? { advisory: true } : {}),
      category: CATEGORY,
      message:
        `Last impact (${risk}) on ${input}${ageStr}: ${direct} direct + ${transitive} transitive, ${pkgs} package(s), ${tests} test(s)` +
        (report.publicApiTouched ? '. Public API touched.' : '.'),
    },
    ...baselineChecks,
  ];
}

function impactBaselineCheck(
  projectRoot: string,
  reportPath: string,
  baselinePath: string,
  nowMs: number,
): IDoctorCheck[] {
  const hasLast = existsSync(reportPath);
  const hasBaseline = existsSync(baselinePath);
  if (!hasBaseline) return [];
  if (!hasLast) {
    return [
      {
        id: 'code-intelligence-impact-baseline',
        title: 'Code-intelligence impact baseline',
        severity: DoctorSeverity.Info,
        category: CATEGORY,
        message:
          'Impact baseline present, but no recent `last.json` to compare against.',
        fix: 'Run `shrk impact --via-graph <target>` to refresh `last.json`.',
      },
    ];
  }
  const baseline = readJsonFile<IImpactRunLike>(baselinePath);
  const last = readJsonFile<IImpactRunLike>(reportPath);
  if (!baseline || !last) {
    return [
      {
        id: 'code-intelligence-impact-baseline',
        title: 'Code-intelligence impact baseline',
        severity: DoctorSeverity.Warning,
        category: CATEGORY,
        message: '.sharkcraft/impact/{baseline,last}.json could not be read.',
        fix: 'Re-freeze with `shrk impact --via-graph <target> && shrk impact baseline write`.',
      },
    ];
  }
  const baseDeps =
    (baseline.directDependentCount ?? 0) + (baseline.transitiveDependentCount ?? 0);
  const lastDeps = (last.directDependentCount ?? 0) + (last.transitiveDependentCount ?? 0);
  const baseRisk = riskRankLike(baseline.risk);
  const lastRisk = riskRankLike(last.risk);
  const riskWorsened = lastRisk > baseRisk;
  const depDelta = lastDeps - baseDeps;
  const pkgDelta =
    (last.affectedPackageCount ?? 0) - (baseline.affectedPackageCount ?? 0);
  const worsened = riskWorsened || depDelta > 0 || pkgDelta > 0;
  void nowMs;
  if (!worsened) {
    return [
      {
        id: 'code-intelligence-impact-baseline',
        title: 'Code-intelligence impact baseline',
        severity: DoctorSeverity.Ok,
        category: CATEGORY,
        message:
          `Impact within baseline — dependents ${depDelta >= 0 ? '+' : ''}${depDelta}, ` +
          `packages ${pkgDelta >= 0 ? '+' : ''}${pkgDelta}.`,
      },
    ];
  }
  const riskStr =
    baseline.risk !== last.risk
      ? `, risk ${baseline.risk} → ${last.risk}`
      : '';
  return [
    {
      id: 'code-intelligence-impact-baseline',
      title: 'Code-intelligence impact baseline',
      severity: DoctorSeverity.Warning,
      category: CATEGORY,
      message:
        `Impact worsened since baseline: ` +
        `dependents ${depDelta >= 0 ? '+' : ''}${depDelta}, ` +
        `packages ${pkgDelta >= 0 ? '+' : ''}${pkgDelta}${riskStr}.`,
      fix: 'Investigate the new dependents. If the growth is intentional, re-freeze with `shrk impact baseline write`.',
      whyThisMatters:
        'A growing impact baseline means edits in this area are increasingly load-bearing — tests + reviews need to scale with it.',
    },
  ];
}

function riskRankLike(r: string | undefined): number {
  switch (r) {
    case 'low':
      return 0;
    case 'medium':
      return 1;
    case 'high':
      return 2;
    case 'critical':
      return 3;
    default:
      return 0;
  }
}

function frameworkChecks(
  projectRoot: string,
  nowMs: number,
  staleDays: number,
): IDoctorCheck[] {
  const metaPath = nodePath.join(projectRoot, '.sharkcraft', 'framework', 'meta.json');
  if (!existsSync(metaPath)) return [];
  const manifest = readJsonFile<IFrameworkManifestLike>(metaPath);
  if (!manifest) {
    return [
      {
        id: 'code-intelligence-framework',
        title: 'Code-intelligence framework scan',
        severity: DoctorSeverity.Warning,
        category: CATEGORY,
        message: '.sharkcraft/framework/meta.json exists but is not valid JSON.',
        fix: 'Rebuild with `shrk graph framework <name>` (or re-run the framework extractor pipeline).',
      },
    ];
  }
  const frameworks = manifest.frameworks ?? [];
  const counts = manifest.countsByFramework ?? {};
  const total = sumValues(counts);
  const days = ageDays(manifest.lastBuiltAt, nowMs);
  const stale = days !== undefined && days > staleDays;
  const ageStr = days !== undefined ? ` (${fmtAge(days)})` : '';
  // Render the per-framework breakdown for the message line. Sorted by
  // count desc so the most-populated framework leads.
  const breakdown = Object.entries(counts)
    .filter(([, n]) => typeof n === 'number' && n > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([k, n]) => `${k}=${n}`)
    .slice(0, 6);
  const breakdownStr = breakdown.length > 0 ? ` [${breakdown.join(', ')}]` : '';

  if (total === 0) {
    return [
      {
        id: 'code-intelligence-framework',
        title: 'Code-intelligence framework scan',
        severity: DoctorSeverity.Info,
        advisory: true,
        category: CATEGORY,
        message: `Framework scan ran but found no framework entities${ageStr}.`,
        fix: 'Check that the scanned files actually contain framework markers (decorators, JSX components, etc.).',
      },
    ];
  }
  if (stale) {
    return [
      {
        id: 'code-intelligence-framework',
        title: 'Code-intelligence framework scan',
        severity: DoctorSeverity.Warning,
        advisory: true,
        category: CATEGORY,
        message: `Framework scan stale${ageStr} — ${total} entities across ${frameworks.length} framework(s)${breakdownStr}.`,
        fix: 'Re-run `shrk graph index` (framework scan rebuilds alongside).',
      },
    ];
  }
  return [
    {
      id: 'code-intelligence-framework',
      title: 'Code-intelligence framework scan',
      severity: DoctorSeverity.Ok,
      category: CATEGORY,
      message: `${total} framework entities across ${frameworks.length} framework(s)${ageStr}${breakdownStr}.`,
    },
  ];
}

function structuralRegistryChecks(projectRoot: string): IDoctorCheck[] {
  const registryPath = nodePath.join(
    projectRoot,
    '.sharkcraft',
    'structural',
    'patterns.json',
  );
  if (!existsSync(registryPath)) return [];
  const reg = readJsonFile<IPatternRegistryLike>(registryPath);
  if (!reg) {
    return [
      {
        id: 'code-intelligence-structural-search',
        title: 'Code-intelligence structural patterns',
        severity: DoctorSeverity.Warning,
        category: CATEGORY,
        message: '.sharkcraft/structural/patterns.json exists but is not valid JSON.',
        fix: 'Inspect with `shrk search-structural registry list` then re-`add` the affected entries.',
      },
    ];
  }
  const patterns = reg.patterns ?? [];
  if (patterns.length === 0) {
    return [
      {
        id: 'code-intelligence-structural-search',
        title: 'Code-intelligence structural patterns',
        severity: DoctorSeverity.Info,
        advisory: true,
        category: CATEGORY,
        message: 'Pattern registry exists but is empty.',
        fix: 'Register patterns via `shrk search-structural registry add --id <id> --pattern <json>`.',
      },
    ];
  }
  const broken = patterns.filter((p) => typeof p.lastValidationError === 'string');
  if (broken.length > 0) {
    const head = broken
      .slice(0, 3)
      .map((p) => `${p.id ?? '?'} (${p.lastValidationError ?? 'invalid'})`)
      .join('; ');
    const tail = broken.length > 3 ? '…' : '';
    return [
      {
        id: 'code-intelligence-structural-search',
        title: 'Code-intelligence structural patterns',
        severity: DoctorSeverity.Warning,
        category: CATEGORY,
        message: `${broken.length}/${patterns.length} registered pattern(s) failed validation: ${head}${tail}`,
        fix: 'Re-validate with `shrk search-structural registry validate`, then re-`add` each failing pattern with a corrected envelope.',
        whyThisMatters:
          'Invalid registry entries never match anything at runtime, so the agent silently misses cases the pattern was meant to flag.',
      },
    ];
  }
  // Roll-up of "needs validation" — entries with no lastValidatedAt at all.
  const unvalidated = patterns.filter((p) => !p.lastValidatedAt);
  if (unvalidated.length > 0) {
    return [
      {
        id: 'code-intelligence-structural-search',
        title: 'Code-intelligence structural patterns',
        severity: DoctorSeverity.Info,
        advisory: true,
        category: CATEGORY,
        message: `${patterns.length} pattern(s) registered, ${unvalidated.length} never validated.`,
        fix: 'Run `shrk search-structural registry validate`.',
      },
    ];
  }
  return [
    {
      id: 'code-intelligence-structural-search',
      title: 'Code-intelligence structural patterns',
      severity: DoctorSeverity.Ok,
      category: CATEGORY,
      message: `${patterns.length} valid pattern(s) registered.`,
    },
  ];
}

function contextPlannerChecks(
  projectRoot: string,
  nowMs: number,
  staleDays: number,
): IDoctorCheck[] {
  // Authoring fixture lives under `sharkcraft/` (checked in, not derived);
  // the run report lives under `.sharkcraft/context-planner/...`.
  const fixturePath = nodePath.join(projectRoot, 'sharkcraft', 'intent-benchmark.json');
  const runPath = nodePath.join(
    projectRoot,
    '.sharkcraft',
    'context-planner',
    'intent-benchmark.json',
  );
  const hasFixture = existsSync(fixturePath);
  const hasRun = existsSync(runPath);
  if (!hasFixture && !hasRun) return [];
  if (hasFixture && !hasRun) {
    return [
      {
        id: 'code-intelligence-context-planner',
        title: 'Code-intelligence intent classifier',
        severity: DoctorSeverity.Info,
        category: CATEGORY,
        message:
          'Intent benchmark fixture present but never run. Doctor cannot report accuracy until you run it.',
        fix: 'Run `shrk context benchmark` once to record accuracy.',
      },
    ];
  }
  const run = hasRun ? readJsonFile<IIntentBenchmarkRunLike>(runPath) : undefined;
  if (!run) {
    return [
      {
        id: 'code-intelligence-context-planner',
        title: 'Code-intelligence intent classifier',
        severity: DoctorSeverity.Warning,
        category: CATEGORY,
        message:
          '.sharkcraft/context-planner/intent-benchmark.json exists but is not valid JSON.',
        fix: 'Re-run `shrk context benchmark` to overwrite the report.',
      },
    ];
  }
  const days = ageDays(run.ranAt, nowMs);
  const ageStr = days !== undefined ? ` (${fmtAge(days)})` : '';
  const stale = days !== undefined && days > staleDays;
  const total = run.total ?? 0;
  const passed = run.passed ?? 0;
  const failed = run.failed ?? Math.max(0, total - passed);
  const accuracy = total === 0 ? 1 : (run.accuracy ?? passed / total);
  const pct = Math.round(accuracy * 1000) / 10;
  if (total === 0) {
    return [
      {
        id: 'code-intelligence-context-planner',
        title: 'Code-intelligence intent classifier',
        severity: DoctorSeverity.Info,
        advisory: true,
        category: CATEGORY,
        message: 'Intent benchmark ran with zero cases.',
        fix: 'Add labelled cases to sharkcraft/intent-benchmark.json.',
      },
    ];
  }
  if (failed > 0) {
    const sample = (run.cases ?? [])
      .filter((c) => c?.passed === false)
      .slice(0, 3)
      .map((c) => `expected=${c?.expected} actual=${c?.actual}`)
      .join('; ');
    return [
      {
        id: 'code-intelligence-context-planner',
        title: 'Code-intelligence intent classifier',
        severity: DoctorSeverity.Warning,
        ...(pct >= 80 ? { advisory: true } : {}),
        category: CATEGORY,
        message:
          `Intent classifier accuracy ${pct}% (${passed}/${total})${ageStr}. ${failed} miss(es): ${sample || '(see report)'}.`,
        fix: 'Inspect with `shrk context benchmark` and add a keyword to `classifyIntent` if the regression is real.',
        whyThisMatters:
          'The classifier drives ranker weights in `shrk context`; wrong intent → wrong files surfaced first → wasted agent turns.',
      },
    ];
  }
  return [
    {
      id: 'code-intelligence-context-planner',
      title: 'Code-intelligence intent classifier',
      severity: stale ? DoctorSeverity.Info : DoctorSeverity.Ok,
      ...(stale ? { advisory: true } : {}),
      category: CATEGORY,
      message: `Intent classifier accuracy ${pct}% (${passed}/${total})${ageStr}.`,
      ...(stale ? { fix: 'Re-run `shrk context benchmark`.' } : {}),
    },
  ];
}

function schemaCompatChecks(projectRoot: string): IDoctorCheck[] {
  const mismatches: { rel: string; expected: string; actual: string; package: string }[] = [];
  // `migrations` is a directory of files; check every state file
  // individually so a single bad write doesn't poison the whole list.
  const migDir = nodePath.join(projectRoot, '.sharkcraft', 'migrations');
  if (existsSync(migDir)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(migDir).filter((f) => f.endsWith('.state.json'));
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const data = readJsonFile<{ schema?: string }>(nodePath.join(migDir, entry));
      if (!data?.schema) continue;
      if (data.schema !== 'sharkcraft.migration-run/v1') {
        mismatches.push({
          rel: `migrations/${entry}`,
          expected: 'sharkcraft.migration-run/v1',
          actual: data.schema,
          package: '@shrkcrft/migrate',
        });
      }
    }
  }
  for (const target of EXPECTED_SCHEMAS) {
    const abs = nodePath.join(projectRoot, '.sharkcraft', target.rel);
    if (!existsSync(abs)) continue;
    const data = readJsonFile<{ schema?: string }>(abs);
    if (!data?.schema) continue;
    if (data.schema !== target.expected) {
      mismatches.push({ ...target, actual: data.schema });
    }
  }
  if (mismatches.length === 0) return [];

  const head = mismatches
    .slice(0, 3)
    .map((m) => `${m.rel} (${m.actual} ≠ ${m.expected})`)
    .join('; ');
  const tail = mismatches.length > 3 ? '…' : '';
  return [
    {
      id: 'code-intelligence-schema-mismatch',
      title: 'Code-intelligence schema compatibility',
      severity: DoctorSeverity.Warning,
      category: CATEGORY,
      message: `${mismatches.length} stored file(s) using outdated schemas: ${head}${tail}`,
      fix:
        mismatches.length === 1
          ? `Regenerate by running the writing package's CLI again (e.g. \`shrk graph index\`, \`shrk gate\`, \`shrk arch check\`).`
          : 'Regenerate the affected stores by re-running each owning CLI (shrk graph index / gate / arch check / api-diff / impact / migrate).',
      whyThisMatters:
        'Schema drift between stored state and the loading package produces empty reads (the loader returns undefined on mismatch). Doctor surfaces the drift so the user knows why a downstream surface suddenly looks blank.',
    },
  ];
}
