/**
 * Architecture map v2.
 *
 * Layered, risk-aware architecture summary built on top of the
 * repository intelligence graph. Detects packages → layer groups,
 * public-API surfaces, current boundary violations, ownership coverage
 * hints, and suggested architecture-review commands.
 *
 * Read-only.
 */
import { existsSync, readFileSync } from 'node:fs';
import { evaluateBoundaries, loadTsconfigPaths, scanImports } from '@shrkcrft/boundaries';
import { analyzeImportGraph } from './import-graph-analysis.ts';
import {
  buildRepositoryIntelligenceGraph,
  RepoNodeKind,
  type IRepositoryIntelligenceGraph,
} from './repository-intelligence.ts';
import { getChangedFiles } from './git-helpers.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const ARCHITECTURE_MAP_SCHEMA = 'sharkcraft.architecture-map/v2';

export type ArchitectureMapFormat = 'text' | 'markdown' | 'html' | 'json';

export type ArchitectureMapInclude =
  | 'layers'
  | 'constructs'
  | 'boundaries'
  | 'policies'
  | 'public-api'
  | 'tests'
  | 'ownership';

export interface IArchitectureLayer {
  id: string;
  label: string;
  members: readonly string[];
}

export interface IArchitectureRisk {
  id: string;
  severity: 'info' | 'warning' | 'error';
  description: string;
}

export interface IArchitectureBoundaryViolation {
  ruleId: string;
  file: string;
  importSpecifier: string;
  severity: 'info' | 'warning' | 'error';
  line: number;
  message: string;
}

export interface IArchitectureHighImpactFile {
  file: string;
  fanIn: number;
  fanOut: number;
}

export interface IArchitectureMap {
  schema: typeof ARCHITECTURE_MAP_SCHEMA;
  generatedAt: string;
  projectRoot: string;
  layers: readonly IArchitectureLayer[];
  publicApiSurfaces: readonly string[];
  boundaryRules: readonly string[];
  boundaryViolations: readonly IArchitectureBoundaryViolation[];
  boundaryViolationCounts: { error: number; warning: number; info: number };
  constructsByKind: readonly { kind: string; count: number }[];
  packs: readonly string[];
  testsCoverageHint: string;
  ownershipCoverageHint: string;
  packArchitectureRules: readonly string[];
  highImpactFiles: readonly IArchitectureHighImpactFile[];
  suggestedReviewCommands: readonly string[];
  risks: readonly IArchitectureRisk[];
  graphSummary: IRepositoryIntelligenceGraph['summaries'];
  signalsEnabled: boolean;
}

const SHARKCRAFT_LAYERS: readonly IArchitectureLayer[] = Object.freeze([
  { id: 'core', label: 'core', members: ['@shrkcrft/core'] },
  {
    id: 'foundations',
    label: 'foundations',
    members: ['@shrkcrft/shared', '@shrkcrft/workspace', '@shrkcrft/config'],
  },
  {
    id: 'asset-registries',
    label: 'asset registries',
    members: [
      '@shrkcrft/knowledge',
      '@shrkcrft/rules',
      '@shrkcrft/paths',
      '@shrkcrft/templates',
      '@shrkcrft/pipelines',
      '@shrkcrft/presets',
      '@shrkcrft/boundaries',
      '@shrkcrft/plugin-api',
    ],
  },
  { id: 'packs', label: 'packs', members: ['@shrkcrft/packs'] },
  {
    id: 'generation',
    label: 'generation/inspection',
    members: ['@shrkcrft/generator', '@shrkcrft/importer', '@shrkcrft/inspector'],
  },
  { id: 'mcp', label: 'mcp', members: ['@shrkcrft/mcp-server'] },
  {
    id: 'cli',
    label: 'cli/dashboard',
    members: ['@shrkcrft/cli', '@shrkcrft/dashboard', '@shrkcrft/dashboard-api', '@shrkcrft/ai'],
  },
]);

export async function buildArchitectureMap(
  inspection: ISharkcraftInspection,
  options: { include?: readonly ArchitectureMapInclude[]; risk?: boolean; signals?: boolean } = {},
): Promise<IArchitectureMap> {
  const include = new Set<ArchitectureMapInclude>(
    options.include && options.include.length > 0
      ? options.include
      : (['layers', 'constructs', 'boundaries', 'policies', 'public-api', 'tests', 'ownership'] as ArchitectureMapInclude[]),
  );
  const signalsEnabled = options.signals === true;
  const graph = await buildRepositoryIntelligenceGraph(inspection, { includeImports: signalsEnabled });

  const packageLabels = new Set(
    graph.nodes.filter((n) => n.kind === RepoNodeKind.Package).map((n) => n.label),
  );

  const layers: IArchitectureLayer[] = include.has('layers')
    ? SHARKCRAFT_LAYERS.map((l) => ({
        id: l.id,
        label: l.label,
        members: l.members.filter((m) => packageLabels.has(m)),
      })).filter((l) => l.members.length > 0)
    : [];

  const publicApiSurfaces = include.has('public-api')
    ? graph.nodes.filter((n) => n.kind === RepoNodeKind.PublicApi).map((n) => n.label)
    : [];

  const boundaryRules = include.has('boundaries')
    ? graph.nodes.filter((n) => n.kind === RepoNodeKind.BoundaryRule).map((n) => n.label)
    : [];

  const constructsByKind = include.has('constructs')
    ? aggregateConstructKinds(graph)
    : [];

  const packs = graph.nodes.filter((n) => n.kind === RepoNodeKind.Pack).map((n) => n.label);

  const testsCoverageHint = include.has('tests')
    ? graph.summaries.tests === 0
      ? 'No test files detected — run `shrk tests missing`.'
      : `${graph.summaries.tests} test file(s) detected.`
    : '';

  const ownershipCoverageHint = include.has('ownership')
    ? graph.summaries.ownership === 0
      ? 'No ownership rules detected — `shrk owners` and `shrk ownership` surfaces are empty.'
      : `${graph.summaries.ownership} ownership rule(s) detected.`
    : '';

  // Boundary violations (real signal when --signals is enabled).
  let boundaryViolations: IArchitectureBoundaryViolation[] = [];
  let boundaryViolationCounts = { error: 0, warning: 0, info: 0 };
  if (signalsEnabled && include.has('boundaries') && inspection.boundaryRegistry.size() > 0) {
    try {
      const scan = scanImports({ projectRoot: inspection.projectRoot });
      const tsconfigPaths = loadTsconfigPaths(inspection.projectRoot);
      const evalResult = evaluateBoundaries(scan, inspection.boundaryRegistry.list(), {
        ...(tsconfigPaths.aliases.size > 0 ? { tsconfigPaths } : {}),
      });
      boundaryViolations = evalResult.violations.slice(0, 50).map((v) => ({
        ruleId: v.ruleId,
        file: v.file,
        importSpecifier: v.importSpecifier,
        severity: v.severity,
        line: v.line,
        message: v.message,
      }));
      boundaryViolationCounts = evalResult.counts;
    } catch {
      /* best-effort */
    }
  }

  // High-impact files from import graph fan-in/fan-out.
  let highImpactFiles: IArchitectureHighImpactFile[] = [];
  if (signalsEnabled) {
    try {
      const ig = analyzeImportGraph(inspection.projectRoot);
      const fanInMap = new Map<string, number>();
      const fanOutMap = new Map<string, number>();
      for (const f of ig.topFanIn) fanInMap.set(f.file, f.in);
      for (const f of ig.topFanOut) fanOutMap.set(f.file, f.out);
      const allFiles = new Set([...fanInMap.keys(), ...fanOutMap.keys()]);
      highImpactFiles = [...allFiles]
        .map((file) => ({ file, fanIn: fanInMap.get(file) ?? 0, fanOut: fanOutMap.get(file) ?? 0 }))
        .sort((a, b) => b.fanIn + b.fanOut - (a.fanIn + a.fanOut))
        .slice(0, 20);
    } catch {
      /* best-effort */
    }
  }

  // Pack-contributed architecture rules: boundary rules with source=pack
  // would surface here; the registry doesn't carry source on the rule
  // itself, so we leave the placeholder empty in v2.
  const packArchitectureRules: string[] = [];

  const suggestedReviewCommands = [
    'shrk check boundaries --json',
    'shrk drift --json',
    'shrk coverage --json',
    'shrk impact --since main',
    'shrk intelligence graph --json',
  ];

  const risks: IArchitectureRisk[] = [];
  if (options.risk !== false) {
    if (graph.summaries.tests === 0) {
      risks.push({
        id: 'no-tests-detected',
        severity: 'warning',
        description: 'No tests detected. Architecture changes should be backed by tests.',
      });
    }
    if (graph.summaries.boundaries === 0) {
      risks.push({
        id: 'no-boundary-rules',
        severity: 'info',
        description: 'No boundary rules declared. Layer enforcement is best-effort.',
      });
    }
    if (boundaryViolationCounts.error > 0) {
      risks.push({
        id: 'boundary-violations-error',
        severity: 'error',
        description: `${boundaryViolationCounts.error} boundary violation(s) at error severity.`,
      });
    }
    if (boundaryViolationCounts.warning > 0) {
      risks.push({
        id: 'boundary-violations-warning',
        severity: 'warning',
        description: `${boundaryViolationCounts.warning} boundary violation(s) at warning severity.`,
      });
    }
    if (graph.truncation.filesCapped) {
      risks.push({
        id: 'file-list-truncated',
        severity: 'info',
        description: `File list truncated at ${graph.truncation.filesCap}; some packages may have files not shown.`,
      });
    }
  }

  return {
    schema: ARCHITECTURE_MAP_SCHEMA,
    generatedAt: new Date().toISOString(),
    projectRoot: inspection.projectRoot,
    layers,
    publicApiSurfaces,
    boundaryRules,
    boundaryViolations,
    boundaryViolationCounts,
    constructsByKind,
    packs,
    testsCoverageHint,
    ownershipCoverageHint,
    packArchitectureRules,
    highImpactFiles,
    suggestedReviewCommands,
    risks,
    graphSummary: graph.summaries,
    signalsEnabled,
  };
}

export interface IArchitectureViolationsReport {
  schema: 'sharkcraft.architecture-violations/v1';
  generatedAt: string;
  total: number;
  byRule: readonly { ruleId: string; count: number }[];
  violations: readonly IArchitectureBoundaryViolation[];
}

export async function buildArchitectureViolations(
  inspection: ISharkcraftInspection,
): Promise<IArchitectureViolationsReport> {
  const violations: IArchitectureBoundaryViolation[] = [];
  if (inspection.boundaryRegistry.size() > 0) {
    try {
      const scan = scanImports({ projectRoot: inspection.projectRoot });
      const tsconfigPaths = loadTsconfigPaths(inspection.projectRoot);
      const evalResult = evaluateBoundaries(scan, inspection.boundaryRegistry.list(), {
        ...(tsconfigPaths.aliases.size > 0 ? { tsconfigPaths } : {}),
      });
      for (const v of evalResult.violations) {
        violations.push({
          ruleId: v.ruleId,
          file: v.file,
          importSpecifier: v.importSpecifier,
          severity: v.severity,
          line: v.line,
          message: v.message,
        });
      }
    } catch {
      /* best-effort */
    }
  }
  const byRuleMap = new Map<string, number>();
  for (const v of violations) byRuleMap.set(v.ruleId, (byRuleMap.get(v.ruleId) ?? 0) + 1);
  const byRule = [...byRuleMap.entries()].map(([ruleId, count]) => ({ ruleId, count })).sort((a, b) => b.count - a.count);
  return {
    schema: 'sharkcraft.architecture-violations/v1',
    generatedAt: new Date().toISOString(),
    total: violations.length,
    byRule,
    violations: violations.slice(0, 100),
  };
}

export type ArchitectureViolationDiffClassification =
  | 'existing-touched'
  | 'new-in-changed-file'
  | 'resolved'
  | 'unknown';

export interface IArchitectureViolationDiffEntry {
  classification: ArchitectureViolationDiffClassification;
  violation: IArchitectureBoundaryViolation;
}

export interface IArchitectureViolationsDiffReport {
  schema: 'sharkcraft.architecture-violations-diff/v1';
  generatedAt: string;
  baselineLoaded: boolean;
  baselineSource?: string;
  filesProvided: readonly string[];
  changedFilesFromGit: boolean;
  warnings: readonly string[];
  totalCurrent: number;
  totalBaseline: number;
  entries: readonly IArchitectureViolationDiffEntry[];
  counts: { existingTouched: number; newInChangedFile: number; resolved: number; unknown: number };
}

export interface IArchitectureViolationsDiffOptions {
  /** Files to scope to (relative to projectRoot). */
  files?: readonly string[];
  /** Git ref to derive changed files from (e.g. `main`). */
  since?: string;
  /** Use only staged files. */
  staged?: boolean;
  /** Baseline JSON path (output of `shrk architecture violations --json`). */
  baselineFile?: string;
}

function normalizeViolationKey(v: IArchitectureBoundaryViolation): string {
  return `${v.file}::${v.line}::${v.ruleId}::${v.importSpecifier}`;
}

function loadBaselineViolations(
  baselineFile: string,
  warnings: string[],
): { violations: IArchitectureBoundaryViolation[]; total: number; source?: string } {
  if (!existsSync(baselineFile)) {
    warnings.push(`Baseline file not found: ${baselineFile}`);
    return { violations: [], total: 0 };
  }
  try {
    const raw = readFileSync(baselineFile, 'utf8');
    const parsed = JSON.parse(raw) as {
      total?: number;
      violations?: IArchitectureBoundaryViolation[];
    };
    return {
      violations: parsed.violations ?? [],
      total: parsed.total ?? (parsed.violations?.length ?? 0),
      source: baselineFile,
    };
  } catch (e) {
    warnings.push(`Baseline JSON parse failed: ${(e as Error).message}`);
    return { violations: [], total: 0 };
  }
}

export async function buildArchitectureViolationsDiff(
  inspection: ISharkcraftInspection,
  options: IArchitectureViolationsDiffOptions = {},
): Promise<IArchitectureViolationsDiffReport> {
  const warnings: string[] = [];
  const explicitFiles = options.files ?? [];
  let changedSet = new Set<string>(explicitFiles);
  let changedFilesFromGit = false;
  if (options.since || options.staged) {
    try {
      const changed = getChangedFiles(inspection.projectRoot, {
        ...(options.since ? { since: options.since } : {}),
        ...(options.staged ? { staged: true } : {}),
      });
      if (changed.length === 0 && options.since) {
        warnings.push(`No changed files detected against ref "${options.since}".`);
      }
      changedFilesFromGit = changed.length > 0 || Boolean(options.since || options.staged);
      for (const c of changed) changedSet.add(c);
    } catch (e) {
      warnings.push(`Failed to derive changed files from git: ${(e as Error).message}`);
    }
  }

  // Current violations (full or scoped)
  const currentReport = await buildArchitectureViolations(inspection);
  const currentViolations = currentReport.violations;
  const baseline =
    options.baselineFile != null ? loadBaselineViolations(options.baselineFile, warnings) : null;
  const baselineKeys = new Set((baseline?.violations ?? []).map(normalizeViolationKey));
  const currentKeys = new Set(currentViolations.map(normalizeViolationKey));

  const entries: IArchitectureViolationDiffEntry[] = [];
  const counts = { existingTouched: 0, newInChangedFile: 0, resolved: 0, unknown: 0 };

  // Filter current to changed files when we have a changed set
  const scoped = changedSet.size > 0
    ? currentViolations.filter((v) => changedSet.has(v.file))
    : currentViolations;

  for (const v of scoped) {
    let classification: ArchitectureViolationDiffClassification = 'unknown';
    if (baseline) {
      if (baselineKeys.has(normalizeViolationKey(v))) classification = 'existing-touched';
      else classification = 'new-in-changed-file';
    } else if (changedSet.size > 0) {
      classification = 'existing-touched';
    } else {
      classification = 'unknown';
    }
    entries.push({ classification, violation: v });
    counts[classification === 'existing-touched' ? 'existingTouched' : classification === 'new-in-changed-file' ? 'newInChangedFile' : 'unknown'] += 1;
  }

  // Resolved: baseline entries not present in current
  if (baseline) {
    for (const v of baseline.violations) {
      if (!currentKeys.has(normalizeViolationKey(v))) {
        entries.push({ classification: 'resolved', violation: v });
        counts.resolved += 1;
      }
    }
  }

  return {
    schema: 'sharkcraft.architecture-violations-diff/v1',
    generatedAt: new Date().toISOString(),
    baselineLoaded: baseline !== null && (baseline.source ?? '').length > 0,
    ...(baseline?.source ? { baselineSource: baseline.source } : {}),
    filesProvided: explicitFiles,
    changedFilesFromGit,
    warnings,
    totalCurrent: currentReport.total,
    totalBaseline: baseline?.total ?? 0,
    entries,
    counts,
  };
}

export function renderArchitectureViolationsDiffText(report: IArchitectureViolationsDiffReport): string {
  const lines: string[] = [];
  lines.push('=== Architecture violations diff ===');
  lines.push(`  current total      ${report.totalCurrent}`);
  if (report.baselineLoaded) lines.push(`  baseline total     ${report.totalBaseline}`);
  lines.push(`  existing-touched   ${report.counts.existingTouched}`);
  lines.push(`  new-in-changed     ${report.counts.newInChangedFile}`);
  lines.push(`  resolved           ${report.counts.resolved}`);
  lines.push(`  unknown            ${report.counts.unknown}`);
  for (const w of report.warnings) lines.push(`  ! ${w}`);
  for (const e of report.entries.slice(0, 50)) {
    const v = e.violation;
    lines.push(`  [${e.classification}] [${v.severity}] ${v.ruleId} ${v.file}:${v.line} → ${v.importSpecifier}`);
  }
  return lines.join('\n') + '\n';
}

export function renderArchitectureViolationsDiffMarkdown(report: IArchitectureViolationsDiffReport): string {
  const lines: string[] = [];
  lines.push('# Architecture violations diff');
  lines.push('');
  lines.push(`- current total: **${report.totalCurrent}**`);
  if (report.baselineLoaded) lines.push(`- baseline total: ${report.totalBaseline}`);
  lines.push(`- existing-touched: ${report.counts.existingTouched}`);
  lines.push(`- new-in-changed: ${report.counts.newInChangedFile}`);
  lines.push(`- resolved: ${report.counts.resolved}`);
  lines.push(`- unknown: ${report.counts.unknown}`);
  if (report.warnings.length > 0) {
    lines.push('');
    lines.push('## Warnings');
    for (const w of report.warnings) lines.push(`- ${w}`);
  }
  if (report.entries.length > 0) {
    lines.push('');
    lines.push('## Entries');
    for (const e of report.entries) {
      const v = e.violation;
      lines.push(`- **${e.classification}** \`${v.ruleId}\` ${v.file}:${v.line} → \`${v.importSpecifier}\``);
    }
  }
  return lines.join('\n') + '\n';
}

export function renderArchitectureViolationsDiffHtml(report: IArchitectureViolationsDiffReport): string {
  const body: string[] = [];
  body.push('<h1>Architecture violations diff</h1>');
  body.push('<ul>');
  body.push(`<li>current total: <strong>${report.totalCurrent}</strong></li>`);
  if (report.baselineLoaded) body.push(`<li>baseline total: ${report.totalBaseline}</li>`);
  body.push(`<li>existing-touched: ${report.counts.existingTouched}</li>`);
  body.push(`<li>new-in-changed: ${report.counts.newInChangedFile}</li>`);
  body.push(`<li>resolved: ${report.counts.resolved}</li>`);
  body.push(`<li>unknown: ${report.counts.unknown}</li>`);
  body.push('</ul>');
  if (report.entries.length > 0) {
    body.push('<table><thead><tr><th>Classification</th><th>Severity</th><th>Rule</th><th>File</th><th>Line</th><th>Specifier</th></tr></thead><tbody>');
    for (const e of report.entries) {
      const v = e.violation;
      body.push(
        `<tr><td>${escapeHtml(e.classification)}</td><td>${escapeHtml(v.severity)}</td><td>${escapeHtml(v.ruleId)}</td><td>${escapeHtml(v.file)}</td><td>${v.line}</td><td>${escapeHtml(v.importSpecifier)}</td></tr>`,
      );
    }
    body.push('</tbody></table>');
  }
  return `<!doctype html><meta charset="utf-8"><title>Architecture violations diff</title>${body.join('\n')}`;
}

export async function buildArchitectureArea(
  inspection: ISharkcraftInspection,
  areaId: string,
): Promise<{
  schema: 'sharkcraft.architecture-area/v1';
  area: string;
  members: readonly string[];
  found: boolean;
}> {
  const map = await buildArchitectureMap(inspection);
  const layer = map.layers.find((l) => l.id === areaId);
  return {
    schema: 'sharkcraft.architecture-area/v1',
    area: areaId,
    members: layer?.members ?? [],
    found: layer !== undefined,
  };
}

function aggregateConstructKinds(graph: IRepositoryIntelligenceGraph): readonly { kind: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const n of graph.nodes) {
    if (n.kind !== RepoNodeKind.Construct) continue;
    const ck = (n.meta as { constructType?: string } | undefined)?.constructType ?? 'unknown';
    counts.set(ck, (counts.get(ck) ?? 0) + 1);
  }
  return [...counts.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderArchitectureMapText(map: IArchitectureMap): string {
  const lines: string[] = [];
  lines.push('=== Architecture map ===');
  lines.push(`  packages          ${map.graphSummary.packages}`);
  lines.push(`  apps              ${map.graphSummary.apps}`);
  lines.push(`  libraries         ${map.graphSummary.libraries}`);
  lines.push(`  constructs        ${map.graphSummary.constructs}`);
  lines.push(`  boundary rules    ${map.boundaryRules.length}`);
  lines.push(`  public api surfs  ${map.publicApiSurfaces.length}`);
  lines.push(`  packs             ${map.packs.length}`);
  if (map.signalsEnabled) {
    lines.push(
      `  boundary violations error=${map.boundaryViolationCounts.error} warning=${map.boundaryViolationCounts.warning} info=${map.boundaryViolationCounts.info}`,
    );
  }
  if (map.layers.length > 0) {
    lines.push('Layers:');
    for (const l of map.layers) lines.push(`  • ${l.label} — ${l.members.length} member(s)`);
  }
  if (map.constructsByKind.length > 0) {
    lines.push('Constructs by kind:');
    for (const c of map.constructsByKind) lines.push(`  • ${c.kind} (${c.count})`);
  }
  if (map.testsCoverageHint) lines.push(`Tests: ${map.testsCoverageHint}`);
  if (map.ownershipCoverageHint) lines.push(`Ownership: ${map.ownershipCoverageHint}`);
  if (map.highImpactFiles.length > 0) {
    lines.push('High-impact files (top 5):');
    for (const f of map.highImpactFiles.slice(0, 5))
      lines.push(`  • ${f.file} (in=${f.fanIn} out=${f.fanOut})`);
  }
  if (map.boundaryViolations.length > 0) {
    lines.push('Top boundary violations:');
    for (const v of map.boundaryViolations.slice(0, 5))
      lines.push(`  [${v.severity}] ${v.ruleId} ${v.file}:${v.line} → ${v.importSpecifier}`);
  }
  if (map.risks.length > 0) {
    lines.push('Risks:');
    for (const r of map.risks) lines.push(`  [${r.severity}] ${r.id} — ${r.description}`);
  }
  lines.push('Suggested review:');
  for (const c of map.suggestedReviewCommands) lines.push(`  $ ${c}`);
  return lines.join('\n') + '\n';
}

export function renderArchitectureMapMarkdown(map: IArchitectureMap): string {
  const lines: string[] = [];
  lines.push('# Architecture map');
  lines.push('');
  lines.push(`Generated: ${map.generatedAt}`);
  lines.push('');
  lines.push('## Layers');
  if (map.layers.length === 0) lines.push('_None detected._');
  else for (const l of map.layers) lines.push(`- **${l.label}** — ${l.members.join(', ')}`);
  lines.push('');
  if (map.publicApiSurfaces.length > 0) {
    lines.push('## Public API surfaces');
    for (const s of map.publicApiSurfaces) lines.push(`- ${s}`);
    lines.push('');
  }
  if (map.boundaryRules.length > 0) {
    lines.push('## Boundary rules');
    for (const b of map.boundaryRules) lines.push(`- ${b}`);
    lines.push('');
  }
  if (map.boundaryViolations.length > 0) {
    lines.push('## Boundary violations');
    for (const v of map.boundaryViolations.slice(0, 20))
      lines.push(`- **${v.severity}** \`${v.ruleId}\` ${v.file}:${v.line} → \`${v.importSpecifier}\``);
    lines.push('');
  }
  if (map.highImpactFiles.length > 0) {
    lines.push('## High-impact files');
    for (const f of map.highImpactFiles.slice(0, 10))
      lines.push(`- \`${f.file}\` — fan-in ${f.fanIn} / fan-out ${f.fanOut}`);
    lines.push('');
  }
  if (map.risks.length > 0) {
    lines.push('## Risks');
    for (const r of map.risks) lines.push(`- **${r.severity}** — ${r.id}: ${r.description}`);
    lines.push('');
  }
  lines.push('## Suggested review');
  for (const c of map.suggestedReviewCommands) lines.push(`- \`${c}\``);
  return lines.join('\n') + '\n';
}

export function renderArchitectureMapHtml(map: IArchitectureMap): string {
  const body: string[] = [];
  body.push('<h1>Architecture map</h1>');
  body.push(`<p>Generated: ${escapeHtml(map.generatedAt)}</p>`);
  body.push('<h2>Layers</h2><ul>');
  for (const l of map.layers) body.push(`<li><strong>${escapeHtml(l.label)}</strong> — ${escapeHtml(l.members.join(', '))}</li>`);
  body.push('</ul>');
  if (map.publicApiSurfaces.length > 0) {
    body.push('<h2>Public API surfaces</h2><ul>');
    for (const s of map.publicApiSurfaces) body.push(`<li>${escapeHtml(s)}</li>`);
    body.push('</ul>');
  }
  if (map.risks.length > 0) {
    body.push('<h2>Risks</h2><ul>');
    for (const r of map.risks)
      body.push(`<li><em>${escapeHtml(r.severity)}</em> — ${escapeHtml(r.id)}: ${escapeHtml(r.description)}</li>`);
    body.push('</ul>');
  }
  return `<!doctype html><meta charset="utf-8"><title>Architecture map</title>${body.join('\n')}`;
}
