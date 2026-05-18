/**
 * Dashboard data export.
 *
 * Aggregates inspector data into a flat set of JSON files that any
 * (downstream) UI can consume. The SharkCraft dashboard ships its own
 * React+Vite bundle; this export is the read-only data feed any other
 * UI could use.
 *
 * Writes only into the user-supplied output directory. Never writes
 * source files.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { buildArchitectureMap } from './architecture-map.ts';
import { buildRepositoryIntelligenceGraph } from './repository-intelligence.ts';
import { buildRepositoryMap } from './repository-map.ts';
import { listRoleViews } from './role-views.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const DASHBOARD_EXPORT_SCHEMA = 'sharkcraft.dashboard-export/v1';

export type DashboardExportSection =
  | 'quality'
  | 'repository-map'
  | 'architecture'
  | 'intelligence'
  | 'commands'
  | 'safety'
  | 'packs'
  | 'sessions'
  | 'bundles'
  | 'recent-reports'
  | 'role-views'
  | 'languages';

export interface IDashboardExportIndexEntry {
  section: DashboardExportSection;
  file: string;
  bytes: number;
}

export interface IDashboardExportReport {
  schema: typeof DASHBOARD_EXPORT_SCHEMA;
  generatedAt: string;
  outputDir: string;
  entries: readonly IDashboardExportIndexEntry[];
}

export interface IDashboardExportOptions {
  outputDir: string;
  include?: readonly DashboardExportSection[];
}

const DEFAULT_SECTIONS: readonly DashboardExportSection[] = [
  'repository-map',
  'architecture',
  'intelligence',
  'commands',
  'safety',
  'packs',
  'sessions',
  'bundles',
  'recent-reports',
  'role-views',
  'languages',
];

function writeSection(dir: string, name: string, data: unknown): IDashboardExportIndexEntry {
  const file = nodePath.join(dir, `${name}.json`);
  const body = JSON.stringify(data, null, 2);
  writeFileSync(file, body, 'utf8');
  return { section: name as DashboardExportSection, file, bytes: Buffer.byteLength(body, 'utf8') };
}

export async function buildDashboardExport(
  inspection: ISharkcraftInspection,
  options: IDashboardExportOptions,
): Promise<IDashboardExportReport> {
  const include = new Set<DashboardExportSection>(
    options.include && options.include.length > 0 ? options.include : DEFAULT_SECTIONS,
  );
  const dir = nodePath.isAbsolute(options.outputDir)
    ? options.outputDir
    : nodePath.resolve(inspection.projectRoot, options.outputDir);
  mkdirSync(dir, { recursive: true });
  const entries: IDashboardExportIndexEntry[] = [];
  if (include.has('repository-map')) {
    entries.push(writeSection(dir, 'repository-map', await buildRepositoryMap(inspection)));
  }
  if (include.has('architecture')) {
    entries.push(writeSection(dir, 'architecture-map', await buildArchitectureMap(inspection)));
  }
  if (include.has('intelligence')) {
    entries.push(writeSection(dir, 'intelligence-graph', await buildRepositoryIntelligenceGraph(inspection)));
  }
  if (include.has('role-views')) {
    entries.push(writeSection(dir, 'role-views', listRoleViews()));
  }
  if (include.has('packs')) {
    entries.push(
      writeSection(dir, 'packs', {
        validPacks: inspection.packs.validPacks ?? [],
        invalidPacks: inspection.packs.invalidPacks ?? [],
        warnings: inspection.packs.warnings ?? [],
      }),
    );
  }
  if (include.has('commands')) {
    entries.push(
      writeSection(dir, 'commands', {
        note: 'Run `shrk commands --json` to fetch the live catalog from the CLI.',
      }),
    );
  }
  if (include.has('safety')) {
    entries.push(
      writeSection(dir, 'safety', {
        note: 'Run `shrk safety audit --json` and `shrk safety audit --deep --json` for the canonical safety surface.',
      }),
    );
  }
  if (include.has('sessions')) {
    entries.push(writeSection(dir, 'sessions', { note: 'Sessions live under .sharkcraft/sessions/.' }));
  }
  if (include.has('bundles')) {
    entries.push(writeSection(dir, 'bundles', { note: 'Bundles live under .sharkcraft/bundles/.' }));
  }
  if (include.has('recent-reports')) {
    entries.push(writeSection(dir, 'recent-reports', { note: 'Reports live under .sharkcraft/reports/.' }));
  }
  if (include.has('languages')) {
    // Language snapshot for the dashboard. Detect locally + run a
    // shallow polyglot dependency scan so the UI can render a card without
    // re-running the analysis.
    const { detectLanguageProfiles, buildLanguageCommandReport, scanPolyglotDependencies } = await import('./languages/index.ts');
    const profiles = detectLanguageProfiles(inspection.projectRoot);
    const commands = buildLanguageCommandReport(inspection.projectRoot, profiles);
    const deps = scanPolyglotDependencies(inspection.projectRoot);
    entries.push(writeSection(dir, 'languages', { profiles, commands, dependencies: deps }));
  }
  // index.json — manifest of what was written.
  const index: IDashboardExportReport = {
    schema: DASHBOARD_EXPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    outputDir: dir,
    entries,
  };
  writeFileSync(nodePath.join(dir, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
  return index;
}

export interface IDashboardExportDiff {
  schema: 'sharkcraft.dashboard-export-diff/v1';
  generatedAt: string;
  oldDir: string;
  newDir: string;
  sections: readonly { section: string; oldBytes: number; newBytes: number; delta: number }[];
  metrics: {
    packs: { old: number; new: number; delta: number };
    commands: { old: number; new: number; delta: number };
    graphNodes: { old: number; new: number; delta: number };
    graphEdges: { old: number; new: number; delta: number };
    architectureRisks: { old: number; new: number; delta: number };
    boundaryViolations: { old: number; new: number; delta: number };
  };
}

function readJsonOrNull(file: string): unknown {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function safeNumber(v: unknown, key: string): number {
  if (!v || typeof v !== 'object') return 0;
  const raw = (v as Record<string, unknown>)[key];
  return typeof raw === 'number' ? raw : 0;
}

export function diffDashboardExports(oldDir: string, newDir: string): IDashboardExportDiff {
  const oldIndex = (readJsonOrNull(nodePath.join(oldDir, 'index.json')) as IDashboardExportReport | null) ?? null;
  const newIndex = (readJsonOrNull(nodePath.join(newDir, 'index.json')) as IDashboardExportReport | null) ?? null;
  const oldEntries = oldIndex?.entries ?? [];
  const newEntries = newIndex?.entries ?? [];
  const byName = new Map<string, { old?: number; new?: number }>();
  for (const e of oldEntries) {
    const existing = byName.get(e.section);
    byName.set(e.section, { ...(existing ?? {}), old: e.bytes });
  }
  for (const e of newEntries) {
    const existing = byName.get(e.section);
    byName.set(e.section, { ...(existing ?? {}), new: e.bytes });
  }
  const sections = [...byName.entries()].map(([section, v]) => ({
    section,
    oldBytes: v.old ?? 0,
    newBytes: v.new ?? 0,
    delta: (v.new ?? 0) - (v.old ?? 0),
  }));

  const oldGraph = readJsonOrNull(nodePath.join(oldDir, 'intelligence-graph.json')) as
    | { nodes?: unknown[]; edges?: unknown[] }
    | null;
  const newGraph = readJsonOrNull(nodePath.join(newDir, 'intelligence-graph.json')) as
    | { nodes?: unknown[]; edges?: unknown[] }
    | null;
  const oldArch = readJsonOrNull(nodePath.join(oldDir, 'architecture-map.json')) as
    | { risks?: unknown[]; boundaryViolationCounts?: { error?: number; warning?: number } }
    | null;
  const newArch = readJsonOrNull(nodePath.join(newDir, 'architecture-map.json')) as
    | { risks?: unknown[]; boundaryViolationCounts?: { error?: number; warning?: number } }
    | null;
  const oldPacks = readJsonOrNull(nodePath.join(oldDir, 'packs.json')) as { validPacks?: unknown[] } | null;
  const newPacks = readJsonOrNull(nodePath.join(newDir, 'packs.json')) as { validPacks?: unknown[] } | null;

  const oldNodes = Array.isArray(oldGraph?.nodes) ? oldGraph!.nodes!.length : 0;
  const newNodes = Array.isArray(newGraph?.nodes) ? newGraph!.nodes!.length : 0;
  const oldEdges = Array.isArray(oldGraph?.edges) ? oldGraph!.edges!.length : 0;
  const newEdges = Array.isArray(newGraph?.edges) ? newGraph!.edges!.length : 0;
  const oldRisks = Array.isArray(oldArch?.risks) ? oldArch!.risks!.length : 0;
  const newRisks = Array.isArray(newArch?.risks) ? newArch!.risks!.length : 0;
  const oldBVE = (oldArch?.boundaryViolationCounts?.error ?? 0) + (oldArch?.boundaryViolationCounts?.warning ?? 0);
  const newBVE = (newArch?.boundaryViolationCounts?.error ?? 0) + (newArch?.boundaryViolationCounts?.warning ?? 0);
  const oldPacksN = Array.isArray(oldPacks?.validPacks) ? oldPacks!.validPacks!.length : 0;
  const newPacksN = Array.isArray(newPacks?.validPacks) ? newPacks!.validPacks!.length : 0;

  return {
    schema: 'sharkcraft.dashboard-export-diff/v1',
    generatedAt: new Date().toISOString(),
    oldDir,
    newDir,
    sections,
    metrics: {
      packs: { old: oldPacksN, new: newPacksN, delta: newPacksN - oldPacksN },
      commands: { old: safeNumber(oldGraph, 'commands'), new: safeNumber(newGraph, 'commands'), delta: 0 },
      graphNodes: { old: oldNodes, new: newNodes, delta: newNodes - oldNodes },
      graphEdges: { old: oldEdges, new: newEdges, delta: newEdges - oldEdges },
      architectureRisks: { old: oldRisks, new: newRisks, delta: newRisks - oldRisks },
      boundaryViolations: { old: oldBVE, new: newBVE, delta: newBVE - oldBVE },
    },
  };
}

export function renderDashboardExportDiffMarkdown(diff: IDashboardExportDiff): string {
  const lines: string[] = [];
  lines.push('# Dashboard export diff');
  lines.push('');
  lines.push(`- packs: ${diff.metrics.packs.old} → ${diff.metrics.packs.new} (Δ ${diff.metrics.packs.delta >= 0 ? '+' : ''}${diff.metrics.packs.delta})`);
  lines.push(`- graph nodes: ${diff.metrics.graphNodes.old} → ${diff.metrics.graphNodes.new}`);
  lines.push(`- graph edges: ${diff.metrics.graphEdges.old} → ${diff.metrics.graphEdges.new}`);
  lines.push(`- architecture risks: ${diff.metrics.architectureRisks.old} → ${diff.metrics.architectureRisks.new}`);
  lines.push(`- boundary violations: ${diff.metrics.boundaryViolations.old} → ${diff.metrics.boundaryViolations.new}`);
  lines.push('');
  lines.push('## Section sizes (bytes)');
  for (const s of diff.sections) lines.push(`- \`${s.section}\`: ${s.oldBytes} → ${s.newBytes} (Δ ${s.delta >= 0 ? '+' : ''}${s.delta})`);
  return lines.join('\n') + '\n';
}

export function renderDashboardExportDiffHtml(diff: IDashboardExportDiff): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body: string[] = [];
  body.push('<h1>Dashboard export diff</h1>');
  body.push('<ul>');
  body.push(`<li>packs: ${diff.metrics.packs.old} → ${diff.metrics.packs.new} (Δ ${diff.metrics.packs.delta})</li>`);
  body.push(`<li>graph nodes: ${diff.metrics.graphNodes.old} → ${diff.metrics.graphNodes.new}</li>`);
  body.push(`<li>graph edges: ${diff.metrics.graphEdges.old} → ${diff.metrics.graphEdges.new}</li>`);
  body.push(`<li>architecture risks: ${diff.metrics.architectureRisks.old} → ${diff.metrics.architectureRisks.new}</li>`);
  body.push(`<li>boundary violations: ${diff.metrics.boundaryViolations.old} → ${diff.metrics.boundaryViolations.new}</li>`);
  body.push('</ul>');
  body.push('<table><thead><tr><th>Section</th><th>Old bytes</th><th>New bytes</th><th>Δ</th></tr></thead><tbody>');
  for (const s of diff.sections) {
    body.push(`<tr><td>${esc(s.section)}</td><td>${s.oldBytes}</td><td>${s.newBytes}</td><td>${s.delta}</td></tr>`);
  }
  body.push('</tbody></table>');
  return `<!doctype html><meta charset="utf-8"><title>Dashboard export diff</title>${body.join('\n')}`;
}
