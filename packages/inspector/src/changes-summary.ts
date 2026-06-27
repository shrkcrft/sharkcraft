/**
 * Changes summary.
 *
 * Generic "what changed and what should I check?" report. Generates a
 * grouped summary over git --since / --staged / --files and surfaces:
 *   - touched packages / areas
 *   - touched commands / MCP tools / schemas / docs / tests / pack assets
 *   - safety-relevant changes (boundaries, plan signing, MCP write surface)
 *   - risk summary
 *   - suggested validation commands
 *
 * Read-only; no AI; deterministic. Schema: sharkcraft.changes-summary/v1.
 */
import { getChangedFiles } from './git-helpers.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const CHANGES_SUMMARY_SCHEMA = 'sharkcraft.changes-summary/v1';

export enum ChangeArea {
  Cli = 'cli',
  McpServer = 'mcp-server',
  Inspector = 'inspector',
  Knowledge = 'knowledge',
  Templates = 'templates',
  Paths = 'paths',
  Pipelines = 'pipelines',
  Presets = 'presets',
  Boundaries = 'boundaries',
  Packs = 'packs',
  Core = 'core',
  Workspace = 'workspace',
  Config = 'config',
  PluginApi = 'plugin-api',
  Importer = 'importer',
  Generator = 'generator',
  PackContrib = 'pack-contributions',
  PackManifest = 'pack-manifest',
  Docs = 'docs',
  Tests = 'tests',
  Examples = 'examples',
  Scripts = 'scripts',
  E2E = 'e2e',
  Sharkcraft = 'sharkcraft-self-config',
  Reports = 'reports',
  Unknown = 'unknown',
}

export interface IChangedFileSummary {
  path: string;
  area: ChangeArea;
  isTest: boolean;
  isDoc: boolean;
  isMcpTool: boolean;
  isCliCommand: boolean;
  isSchema: boolean;
  isPackAsset: boolean;
  isSafetyRelevant: boolean;
}

export interface IChangesSummaryReport {
  schema: typeof CHANGES_SUMMARY_SCHEMA;
  generatedAt: string;
  source: 'since' | 'staged' | 'files' | 'working-tree';
  ref?: string;
  /** Optional round / label that this diff represents. */
  roundLabel?: string;
  totalFiles: number;
  filesByArea: Record<string, readonly string[]>;
  files: readonly IChangedFileSummary[];
  /** Touched CLI command files (relative). */
  touchedCommands: readonly string[];
  /** Touched MCP tool files. */
  touchedMcpTools: readonly string[];
  /** Touched JSON schema or schema-like files. */
  touchedSchemas: readonly string[];
  /** Touched docs files. */
  touchedDocs: readonly string[];
  /** Touched test files. */
  touchedTests: readonly string[];
  /** Touched pack manifest / pack assets. */
  touchedPackAssets: readonly string[];
  /** Touched safety-relevant files. */
  safetyRelevantFiles: readonly string[];
  /** Risk verdict — low | medium | high. */
  risk: 'low' | 'medium' | 'high';
  /** Reasons backing the risk verdict. */
  riskReasons: readonly string[];
  /** Suggested validation commands. */
  suggestedValidationCommands: readonly string[];
  /** Likely PR-title-style summary. */
  likelyPrSummary: string;
}

export interface IChangesSummaryOptions {
  /** Diff base (used with --since). */
  since?: string;
  /** Use git diff --cached. */
  staged?: boolean;
  /** Explicit file list, bypasses git. */
  files?: readonly string[];
  /** Optional round / label captured into the report (no behavioural effect). */
  roundLabel?: string;
}

function classifyArea(file: string): ChangeArea {
  if (file.startsWith('packages/cli/')) return ChangeArea.Cli;
  if (file.startsWith('packages/mcp-server/')) return ChangeArea.McpServer;
  if (file.startsWith('packages/inspector/')) return ChangeArea.Inspector;
  if (file.startsWith('packages/knowledge/')) return ChangeArea.Knowledge;
  if (file.startsWith('packages/templates/')) return ChangeArea.Templates;
  if (file.startsWith('packages/paths/')) return ChangeArea.Paths;
  if (file.startsWith('packages/pipelines/')) return ChangeArea.Pipelines;
  if (file.startsWith('packages/presets/')) return ChangeArea.Presets;
  if (file.startsWith('packages/boundaries/')) return ChangeArea.Boundaries;
  if (file.startsWith('packages/packs/')) return ChangeArea.Packs;
  if (file.startsWith('packages/core/')) return ChangeArea.Core;
  if (file.startsWith('packages/workspace/')) return ChangeArea.Workspace;
  if (file.startsWith('packages/config/')) return ChangeArea.Config;
  if (file.startsWith('packages/plugin-api/')) return ChangeArea.PluginApi;
  if (file.startsWith('packages/importer/')) return ChangeArea.Importer;
  if (file.startsWith('packages/generator/')) return ChangeArea.Generator;
  if (file.startsWith('docs/')) return ChangeArea.Docs;
  if (file.startsWith('e2e/')) return ChangeArea.E2E;
  if (file.startsWith('examples/')) return ChangeArea.Examples;
  if (file.startsWith('scripts/')) return ChangeArea.Scripts;
  if (file.startsWith('sharkcraft/')) return ChangeArea.Sharkcraft;
  if (file.startsWith('.sharkcraft/')) return ChangeArea.Reports;
  if (/(?:^|\/)[\w-]*sharkcraft-pack\//.test(file)) {
    return ChangeArea.PackContrib;
  }
  // Extension fallback so the summary stays useful in non-SharkCraft repos
  // (e.g. a foreign monorepo's `architecture/*.md`) instead of bucketing every
  // doc as `unknown`.
  if (/\.mdx?$/i.test(file)) return ChangeArea.Docs;
  return ChangeArea.Unknown;
}

function classifyFile(file: string): IChangedFileSummary {
  const area = classifyArea(file);
  const lower = file.toLowerCase();
  const isTest =
    lower.includes('__tests__/') ||
    lower.endsWith('.test.ts') ||
    lower.endsWith('.spec.ts') ||
    lower.endsWith('.test.tsx') ||
    lower.endsWith('.spec.tsx');
  const isDoc = lower.endsWith('.md') || area === ChangeArea.Docs;
  const isMcpTool = lower.startsWith('packages/mcp-server/src/tools/') && lower.endsWith('.ts');
  const isCliCommand = lower.startsWith('packages/cli/src/commands/') && lower.endsWith('.ts');
  const isSchema = lower.includes('schema') && (lower.endsWith('.json') || lower.endsWith('.ts'));
  const isPackAsset = area === ChangeArea.PackContrib || area === ChangeArea.Packs;
  const isSafetyRelevant =
    isMcpTool ||
    lower.includes('safety-audit') ||
    lower.includes('command-catalog') ||
    lower.includes('plan-signing') ||
    lower.includes('boundaries-changed-only') ||
    lower.includes('apply.command') ||
    lower.startsWith('packages/generator/src/plan');
  return {
    path: file,
    area,
    isTest,
    isDoc,
    isMcpTool,
    isCliCommand,
    isSchema,
    isPackAsset,
    isSafetyRelevant,
  };
}

function groupByArea(files: readonly IChangedFileSummary[]): Record<string, readonly string[]> {
  const out: Record<string, string[]> = {};
  for (const f of files) {
    const key = f.area;
    if (!out[key]) out[key] = [];
    out[key]!.push(f.path);
  }
  for (const key of Object.keys(out)) out[key]!.sort();
  return out as Record<string, readonly string[]>;
}

function computeRisk(files: readonly IChangedFileSummary[]): {
  risk: 'low' | 'medium' | 'high';
  reasons: string[];
} {
  const reasons: string[] = [];
  let score = 0;
  const mcpCount = files.filter((f) => f.isMcpTool).length;
  if (mcpCount > 0) {
    reasons.push(`${mcpCount} MCP tool file(s) touched — run safety audit`);
    score += 3;
  }
  const safetyCount = files.filter((f) => f.isSafetyRelevant).length;
  if (safetyCount > 0) {
    reasons.push(`${safetyCount} safety-relevant file(s) touched`);
    score += 2;
  }
  const writeCmd = files.filter(
    (f) =>
      f.isCliCommand &&
      (f.path.includes('apply') || f.path.includes('gen') || f.path.includes('init')),
  ).length;
  if (writeCmd > 0) {
    reasons.push(`${writeCmd} write-path command file(s) touched`);
    score += 2;
  }
  const packCount = files.filter((f) => f.isPackAsset).length;
  if (packCount > 0) {
    reasons.push(`${packCount} pack asset file(s) touched — re-sign before publish`);
    score += 1;
  }
  if (files.length > 25) {
    reasons.push(`${files.length} files changed — large diff`);
    score += 1;
  }
  if (score >= 5) return { risk: 'high', reasons };
  if (score >= 2) return { risk: 'medium', reasons };
  return { risk: 'low', reasons };
}

function suggestValidationCommands(files: readonly IChangedFileSummary[]): string[] {
  const out = new Set<string>();
  out.add('bun x tsc -p tsconfig.base.json --noEmit');
  out.add('bun test');
  if (files.some((f) => f.isMcpTool)) {
    out.add('shrk safety audit --deep');
    out.add('shrk commands doctor');
  }
  if (files.some((f) => f.isCliCommand)) {
    out.add('shrk commands doctor');
    out.add('shrk commands ux-check');
  }
  if (files.some((f) => f.area === ChangeArea.Knowledge || f.area === ChangeArea.Sharkcraft)) {
    out.add('shrk doctor');
    out.add('shrk knowledge stale-check --ci');
  }
  if (files.some((f) => f.area === ChangeArea.Templates || f.path.includes('templates'))) {
    out.add('shrk templates drift --min-severity warning');
  }
  if (files.some((f) => f.area === ChangeArea.Boundaries || f.path.endsWith('boundaries.ts'))) {
    out.add('shrk check boundaries --changed-only');
  }
  if (files.some((f) => f.isPackAsset)) {
    out.add('shrk packs doctor');
    out.add('shrk packs verify');
  }
  if (files.some((f) => f.area === ChangeArea.Inspector)) {
    out.add('shrk product check');
  }
  return Array.from(out);
}

function buildPrSummary(files: readonly IChangedFileSummary[]): string {
  const areaCounts = new Map<string, number>();
  for (const f of files) areaCounts.set(f.area, (areaCounts.get(f.area) ?? 0) + 1);
  const top = [...areaCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (top.length === 0) return 'No changes';
  return `Changes across: ${top.map(([a, c]) => `${a} (${c})`).join(', ')}`;
}

export async function buildChangesSummary(
  inspection: ISharkcraftInspection,
  options: IChangesSummaryOptions = {},
): Promise<IChangesSummaryReport> {
  const cwd = inspection.projectRoot;
  let changedFiles: readonly string[] = [];
  let source: IChangesSummaryReport['source'] = 'working-tree';
  let ref: string | undefined;
  if (options.files && options.files.length > 0) {
    changedFiles = options.files;
    source = 'files';
  } else if (options.staged) {
    changedFiles = getChangedFiles(cwd, { staged: true });
    source = 'staged';
  } else if (options.since) {
    changedFiles = getChangedFiles(cwd, { since: options.since });
    source = 'since';
    ref = options.since;
  } else {
    // Default working-tree view must include untracked files — otherwise a
    // brand-new (never-staged) file is invisible to the summary, which made
    // `totalFiles` undercount whole untracked directories. Mirrors every other
    // working-tree caller (boundaries / propose-knowledge / architecture).
    changedFiles = getChangedFiles(cwd, { includeWorktree: true });
    source = 'working-tree';
  }
  const classified = changedFiles.map(classifyFile);
  const filesByArea = groupByArea(classified);
  const touchedCommands = classified.filter((c) => c.isCliCommand).map((c) => c.path);
  const touchedMcpTools = classified.filter((c) => c.isMcpTool).map((c) => c.path);
  const touchedSchemas = classified.filter((c) => c.isSchema).map((c) => c.path);
  const touchedDocs = classified.filter((c) => c.isDoc).map((c) => c.path);
  const touchedTests = classified.filter((c) => c.isTest).map((c) => c.path);
  const touchedPackAssets = classified.filter((c) => c.isPackAsset).map((c) => c.path);
  const safetyRelevantFiles = classified.filter((c) => c.isSafetyRelevant).map((c) => c.path);
  const { risk, reasons } = computeRisk(classified);
  return {
    schema: CHANGES_SUMMARY_SCHEMA,
    generatedAt: new Date().toISOString(),
    source,
    ...(ref ? { ref } : {}),
    ...(options.roundLabel ? { roundLabel: options.roundLabel } : {}),
    totalFiles: classified.length,
    filesByArea,
    files: classified,
    touchedCommands,
    touchedMcpTools,
    touchedSchemas,
    touchedDocs,
    touchedTests,
    touchedPackAssets,
    safetyRelevantFiles,
    risk,
    riskReasons: reasons,
    suggestedValidationCommands: suggestValidationCommands(classified),
    likelyPrSummary: buildPrSummary(classified),
  };
}

export function renderChangesSummaryMarkdown(report: IChangesSummaryReport): string {
  const lines: string[] = [];
  lines.push('# Changes summary');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Source: ${report.source}${report.ref ? ` (ref=${report.ref})` : ''}`);
  lines.push('');
  lines.push(`- total files: ${report.totalFiles}`);
  lines.push(`- risk: **${report.risk}**`);
  if (report.riskReasons.length > 0) {
    lines.push('  - ' + report.riskReasons.join('\n  - '));
  }
  lines.push('');
  lines.push('## Files by area');
  for (const [area, files] of Object.entries(report.filesByArea)) {
    lines.push(`### ${area} (${files.length})`);
    for (const f of files) lines.push(`- ${f}`);
  }
  if (report.touchedCommands.length > 0) {
    lines.push('');
    lines.push('## Touched CLI commands');
    for (const c of report.touchedCommands) lines.push(`- ${c}`);
  }
  if (report.touchedMcpTools.length > 0) {
    lines.push('');
    lines.push('## Touched MCP tools (read-only invariant — verify!)');
    for (const t of report.touchedMcpTools) lines.push(`- ${t}`);
  }
  if (report.touchedDocs.length > 0) {
    lines.push('');
    lines.push('## Touched docs');
    for (const d of report.touchedDocs) lines.push(`- ${d}`);
  }
  if (report.touchedTests.length > 0) {
    lines.push('');
    lines.push('## Touched tests');
    for (const t of report.touchedTests) lines.push(`- ${t}`);
  }
  if (report.touchedPackAssets.length > 0) {
    lines.push('');
    lines.push('## Touched pack assets (re-sign before publish)');
    for (const p of report.touchedPackAssets) lines.push(`- ${p}`);
  }
  lines.push('');
  lines.push('## Suggested validation commands');
  for (const c of report.suggestedValidationCommands) lines.push(`- \`${c}\``);
  lines.push('');
  lines.push('## Likely PR summary');
  lines.push(`> ${report.likelyPrSummary}`);
  return lines.join('\n') + '\n';
}
