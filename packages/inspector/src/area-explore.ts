/**
 * Workspace-aware "explore this directory".
 *
 * Answers "explain this *specific* directory" with one deterministic
 * call. Built on top of `buildAreaMap` (whole-repo) and the registries
 * already in `ISharkcraftInspection`.
 *
 * Output:
 *   - inferred area kind + role,
 *   - key modules (largest / construct-defining),
 *   - related commands (from the command catalog the caller injects),
 *   - related MCP tools (id proximity to area name),
 *   - tests under the dir,
 *   - boundary rules / path conventions that mention the dir,
 *   - common edit risks (generated files, signed/sensitive files,
 *     dist/ subdir, etc.).
 *
 * Pure-data; no execution.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { AreaKind, buildAreaMap } from './area-map.ts';

export const AREA_EXPLORE_SCHEMA = 'sharkcraft.area-explore/v1';

export interface IAreaExploreFileEntry {
  readonly relPath: string;
  readonly sizeBytes: number;
  readonly kind: 'source' | 'test' | 'doc' | 'generated' | 'config' | 'other';
}

export interface IAreaExploreRiskEntry {
  readonly kind:
    | 'generated-files'
    | 'high-fan-in'
    | 'signed-asset'
    | 'mcp-tool-dir'
    | 'cli-write-path'
    | 'pack-contribution'
    | 'no-tests';
  readonly message: string;
  readonly severity: 'info' | 'warning';
}

export interface IAreaExploreReport {
  readonly schema: typeof AREA_EXPLORE_SCHEMA;
  readonly projectRoot: string;
  readonly path: string;
  readonly resolvedPath: string;
  readonly exists: boolean;
  readonly inferredKind: AreaKind;
  readonly role: string;
  readonly fileCount: number;
  readonly testCount: number;
  readonly keyFiles: ReadonlyArray<IAreaExploreFileEntry>;
  readonly relatedCommands: ReadonlyArray<string>;
  readonly relatedMcpTools: ReadonlyArray<string>;
  readonly relatedTemplates: ReadonlyArray<string>;
  readonly relatedPipelines: ReadonlyArray<string>;
  readonly boundaryRuleIds: ReadonlyArray<string>;
  readonly pathConventionIds: ReadonlyArray<string>;
  readonly risks: ReadonlyArray<IAreaExploreRiskEntry>;
  readonly nextCommands: ReadonlyArray<string>;
}

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.sharkcraft',
  'dist',
  'build',
  '.cache',
  '.turbo',
  '.nx',
  'coverage',
  '.next',
]);

function classifyFileKind(file: string): IAreaExploreFileEntry['kind'] {
  if (/\.(test|spec)\.[tj]sx?$/.test(file) || file.includes('/__tests__/')) return 'test';
  if (/\.md$/.test(file)) return 'doc';
  if (/\/dist\/|\.d\.ts$|\.map$|\/generated\//.test(file)) return 'generated';
  if (
    /^(package\.json|tsconfig\.json|tsconfig\.[a-z]+\.json|\.eslintrc|\.prettierrc|\.editorconfig|bun\.lockb)$/.test(
      file.split('/').pop() ?? '',
    )
  )
    return 'config';
  if (/\.(ts|tsx|js|jsx|mjs|cjs|json)$/.test(file)) return 'source';
  return 'other';
}

function walkLimited(root: string, base: string, maxFiles = 4000): string[] {
  const out: string[] = [];
  const stack: string[] = [base];
  while (stack.length > 0 && out.length < maxFiles) {
    const rel = stack.pop()!;
    const abs = nodePath.join(root, rel);
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.startsWith('.') && !['.github', '.gitlab'].includes(name)) continue;
      if (IGNORE_DIRS.has(name)) continue;
      const childRel = rel ? `${rel}/${name}` : name;
      const childAbs = nodePath.join(root, childRel);
      let stat;
      try {
        stat = statSync(childAbs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        stack.push(childRel);
      } else if (stat.isFile()) {
        out.push(childRel);
      }
    }
  }
  return out;
}

function inferKindForPath(relPath: string, areaMap: ReturnType<typeof buildAreaMap>): AreaKind {
  for (const a of areaMap.areas) {
    if (a.paths.some((p) => relPath === p || relPath.startsWith(p + '/'))) return a.kind;
  }
  // fallback heuristics: match against AreaPatterns through area-map
  if (/^packages\//.test(relPath) || /^apps\//.test(relPath)) {
    if (/\/__tests__\//.test(relPath)) return AreaKind.Tests;
  }
  return AreaKind.Unknown;
}

function describeRole(relPath: string, kind: AreaKind): string {
  const segs = relPath.split('/');
  if (relPath.startsWith('packages/cli/src/commands')) {
    return 'CLI command handlers (one .command.ts per shrk subcommand).';
  }
  if (relPath.startsWith('packages/mcp-server/src/tools')) {
    return 'MCP read-only tools (must never write).';
  }
  if (/^packages\/[a-z-]+\/src\/__tests__/.test(relPath)) {
    return 'Unit tests for the parent package.';
  }
  if (/^packages\/[a-z-]+\/src$/.test(relPath)) {
    return `Source root for package ${segs[1]}.`;
  }
  if (relPath === 'docs' || relPath.startsWith('docs/')) {
    return 'Authoritative docs (per-feature; cross-linked from docs/overview.md).';
  }
  if (relPath === 'sharkcraft' || relPath.startsWith('sharkcraft/')) {
    return 'Local SharkCraft registries (rules / paths / templates / pipelines / config).';
  }
  if (relPath === 'scripts' || relPath.startsWith('scripts/')) {
    return 'Repo-level shell/TS scripts (release, publish, preflight).';
  }
  if (relPath.startsWith('examples/')) {
    return 'Dogfood / fixture target packages.';
  }
  switch (kind) {
    case AreaKind.Core:
      return 'Core building blocks (Result, errors, ids).';
    case AreaKind.Tests:
      return 'Tests.';
    case AreaKind.Docs:
      return 'Documentation.';
    case AreaKind.Generated:
      return 'Generated output — do not hand-edit.';
    default:
      return `${kind} area.`;
  }
}

function detectRisks(opts: {
  relPath: string;
  files: ReadonlyArray<IAreaExploreFileEntry>;
  inferredKind: AreaKind;
}): IAreaExploreRiskEntry[] {
  const risks: IAreaExploreRiskEntry[] = [];
  const hasTests = opts.files.some((f) => f.kind === 'test');
  const hasGenerated = opts.files.some((f) => f.kind === 'generated');
  if (opts.relPath.startsWith('packages/mcp-server/src/tools')) {
    risks.push({
      kind: 'mcp-tool-dir',
      severity: 'warning',
      message:
        'MCP tools must remain read-only — never add file writes. Returning a next-command hint is fine.',
    });
  }
  if (
    opts.relPath.startsWith('packages/cli/src/commands') ||
    opts.relPath.startsWith('packages/generator/src')
  ) {
    risks.push({
      kind: 'cli-write-path',
      severity: 'info',
      message:
        'CLI is the only write path. Apply requires --verify-signature on signed plans; do not weaken this.',
    });
  }
  if (opts.relPath.startsWith('packages/packs/')) {
    risks.push({
      kind: 'signed-asset',
      severity: 'warning',
      message:
        'Pack manifests are HMAC-signed. Re-sign with `shrk packs sign` after changing pack assets.',
    });
  }
  if (/sharkcraft-pack|sharkcraft\/pack/.test(opts.relPath)) {
    risks.push({
      kind: 'pack-contribution',
      severity: 'info',
      message:
        'Pack-contributed assets must not introduce project-specific logic into the engine — keep the adapter/pack boundary clean.',
    });
  }
  if (hasGenerated) {
    risks.push({
      kind: 'generated-files',
      severity: 'info',
      message:
        'Contains generated files (dist/ / .d.ts / .map) — do not hand-edit; rebuild via `bun run build:dist`.',
    });
  }
  if (
    !hasTests &&
    opts.files.length > 5 &&
    opts.relPath.startsWith('packages/') &&
    !opts.relPath.startsWith('packages/shared')
  ) {
    risks.push({
      kind: 'no-tests',
      severity: 'warning',
      message:
        'No tests detected in this directory — add one before extending public surface.',
    });
  }
  return risks;
}

function commandRelevance(command: string, area: string): number {
  const tokens = area.toLowerCase().split(/[/\-_.]/).filter((t) => t.length >= 3);
  let score = 0;
  for (const t of tokens) {
    if (command.toLowerCase().includes(t)) score += 1;
  }
  return score;
}

export interface IExploreAreaInput {
  inspection: ISharkcraftInspection;
  /** Directory to explore, relative to the project root (or absolute). */
  path: string;
  /** Caller-injected command catalog (catalog entries with a `command` field). */
  commandCatalog?: ReadonlyArray<{ command: string }>;
  /** Caller-injected MCP tool names (id strings). */
  mcpToolNames?: ReadonlyArray<string>;
  /** Path-convention registry (best-effort). */
  pathConventions?: ReadonlyArray<{ id: string; pattern?: string; path?: string }>;
  /** Limit on key files surfaced. */
  topFiles?: number;
}

export function exploreArea(input: IExploreAreaInput): IAreaExploreReport {
  const root = input.inspection.projectRoot;
  const rawPath = input.path;
  const absPath = nodePath.isAbsolute(rawPath) ? rawPath : nodePath.resolve(root, rawPath);
  const relPath = nodePath.relative(root, absPath).split(nodePath.sep).join('/');
  const exists = existsSync(absPath);
  if (!exists) {
    return {
      schema: AREA_EXPLORE_SCHEMA,
      projectRoot: root,
      path: rawPath,
      resolvedPath: relPath,
      exists: false,
      inferredKind: AreaKind.Unknown,
      role: `Path does not exist: ${relPath}`,
      fileCount: 0,
      testCount: 0,
      keyFiles: [],
      relatedCommands: [],
      relatedMcpTools: [],
      relatedTemplates: [],
      relatedPipelines: [],
      boundaryRuleIds: [],
      pathConventionIds: [],
      risks: [],
      nextCommands: [`shrk map  # repo-wide map`],
    };
  }
  const stat = statSync(absPath);
  const isDir = stat.isDirectory();

  const files: IAreaExploreFileEntry[] = [];
  if (isDir) {
    const rels = walkLimited(root, relPath || '.');
    for (const r of rels) {
      let st;
      try {
        st = statSync(nodePath.join(root, r));
      } catch {
        continue;
      }
      files.push({ relPath: r, sizeBytes: st.size, kind: classifyFileKind(r) });
    }
  } else {
    files.push({
      relPath,
      sizeBytes: stat.size,
      kind: classifyFileKind(relPath),
    });
  }
  // Secondary key makes the order TOTAL: same-size files near the cutoff would
  // otherwise be ranked by filesystem order (non-deterministic).
  files.sort((a, b) => b.sizeBytes - a.sizeBytes || a.relPath.localeCompare(b.relPath));

  const areaMap = buildAreaMap(input.inspection);
  const inferredKind = inferKindForPath(relPath, areaMap);
  const role = describeRole(relPath, inferredKind);

  const topFiles = input.topFiles ?? 10;
  const keyFiles = files
    .filter((f) => f.kind === 'source' || f.kind === 'config')
    .slice(0, topFiles);

  // Related commands by token overlap.
  const commands = (input.commandCatalog ?? [])
    .map((c) => ({ command: c.command, score: commandRelevance(c.command, relPath) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((x) => x.command);

  const mcpTools = (input.mcpToolNames ?? [])
    .map((t) => ({ tool: t, score: commandRelevance(t, relPath) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((x) => x.tool);

  // Boundary rules and path conventions that reference this dir.
  // Boundary rules carry `from` globs (file patterns) and import lists; we
  // only match against `from` since that's the file-side.
  const boundaryRules = input.inspection.boundaryRegistry.list();
  const boundaryRuleIds = boundaryRules
    .filter((r) => {
      const from = r.from ?? [];
      return from.some((p) => {
        const stripped = String(p).replace(/[*?]/g, '');
        return stripped.length > 0 && (relPath.includes(stripped) || stripped.includes(relPath));
      });
    })
    .map((r) => r.id);

  const pathConventions = (input.pathConventions ?? [])
    .filter((p) => {
      const pat = (p.pattern ?? p.path ?? '').replace(/[*?]/g, '');
      return pat && (relPath.includes(pat) || pat.includes(relPath));
    })
    .map((p) => p.id);

  // Related templates / pipelines from the registries (heuristic).
  const templates = input.inspection.templateRegistry.list();
  const relatedTemplates = templates
    .filter((t) => {
      const tp = (t as unknown as { targetPath?: unknown }).targetPath;
      return typeof tp === 'string' && relPath && tp.includes(relPath.split('/').pop() ?? '');
    })
    .map((t) => t.id);

  const pipelines = input.inspection.pipelineRegistry.list();
  const relatedPipelines = pipelines
    .filter((p) =>
      (p.steps ?? []).some((s) => JSON.stringify(s).toLowerCase().includes(relPath.toLowerCase())),
    )
    .map((p) => p.id);

  const risks = detectRisks({ relPath, files, inferredKind });

  const testCount = files.filter((f) => f.kind === 'test').length;

  const nextCommands: string[] = [];
  nextCommands.push(`shrk impact --files "${relPath}"`);
  nextCommands.push(`shrk check boundaries --files "${relPath}"`);
  if (testCount === 0 && isDir) nextCommands.push(`shrk tests missing --area "${relPath}"`);
  if (relPath.startsWith('packages/')) nextCommands.push(`shrk architecture area packages/${relPath.split('/')[1]}`);

  return {
    schema: AREA_EXPLORE_SCHEMA,
    projectRoot: root,
    path: rawPath,
    resolvedPath: relPath,
    exists: true,
    inferredKind,
    role,
    fileCount: files.length,
    testCount,
    keyFiles,
    relatedCommands: commands,
    relatedMcpTools: mcpTools,
    relatedTemplates,
    relatedPipelines,
    boundaryRuleIds,
    pathConventionIds: pathConventions,
    risks,
    nextCommands,
  };
}

export function renderAreaExploreText(report: IAreaExploreReport): string {
  const lines: string[] = [];
  lines.push(`=== Explore: ${report.resolvedPath || '(root)'} ===`);
  if (!report.exists) {
    lines.push(`  path does not exist.`);
    return lines.join('\n') + '\n';
  }
  lines.push(`  kind:  ${report.inferredKind}`);
  lines.push(`  role:  ${report.role}`);
  lines.push(`  files: ${report.fileCount}  tests: ${report.testCount}`);
  if (report.keyFiles.length > 0) {
    lines.push('\nKey files:');
    for (const f of report.keyFiles) {
      lines.push(`  ${f.kind.padEnd(9)} ${f.relPath}  (${f.sizeBytes}B)`);
    }
  }
  if (report.relatedCommands.length > 0) {
    lines.push('\nRelated commands:');
    for (const c of report.relatedCommands) lines.push(`  $ shrk ${c}`);
  }
  if (report.relatedMcpTools.length > 0) {
    lines.push('\nRelated MCP tools:');
    for (const t of report.relatedMcpTools) lines.push(`  • ${t}`);
  }
  if (report.relatedTemplates.length > 0) {
    lines.push('\nRelated templates:');
    for (const t of report.relatedTemplates) lines.push(`  • ${t}`);
  }
  if (report.relatedPipelines.length > 0) {
    lines.push('\nRelated pipelines:');
    for (const p of report.relatedPipelines) lines.push(`  • ${p}`);
  }
  if (report.boundaryRuleIds.length > 0) {
    lines.push('\nBoundary rules covering this dir:');
    for (const r of report.boundaryRuleIds) lines.push(`  • ${r}`);
  }
  if (report.pathConventionIds.length > 0) {
    lines.push('\nPath conventions covering this dir:');
    for (const p of report.pathConventionIds) lines.push(`  • ${p}`);
  }
  if (report.risks.length > 0) {
    lines.push('\nCommon edit risks:');
    for (const r of report.risks) {
      const tag = r.severity === 'warning' ? 'WARN' : 'INFO';
      lines.push(`  [${tag}] ${r.kind.padEnd(20)} ${r.message}`);
    }
  }
  if (report.nextCommands.length > 0) {
    lines.push('\nNext:');
    for (const n of report.nextCommands) lines.push(`  $ ${n}`);
  }
  return lines.join('\n') + '\n';
}

export function renderAreaExploreMarkdown(report: IAreaExploreReport): string {
  const lines: string[] = [];
  lines.push(`# Explore: \`${report.resolvedPath || '(root)'}\``);
  lines.push('');
  if (!report.exists) {
    lines.push(`Path does not exist.`);
    return lines.join('\n') + '\n';
  }
  lines.push(`- **Kind:** ${report.inferredKind}`);
  lines.push(`- **Role:** ${report.role}`);
  lines.push(`- **Files:** ${report.fileCount} (tests: ${report.testCount})`);
  if (report.keyFiles.length > 0) {
    lines.push('');
    lines.push('## Key files');
    for (const f of report.keyFiles) lines.push(`- \`${f.relPath}\` _(${f.kind}, ${f.sizeBytes}B)_`);
  }
  if (report.relatedCommands.length > 0) {
    lines.push('');
    lines.push('## Related commands');
    for (const c of report.relatedCommands) lines.push(`- \`shrk ${c}\``);
  }
  if (report.relatedMcpTools.length > 0) {
    lines.push('');
    lines.push('## Related MCP tools');
    for (const t of report.relatedMcpTools) lines.push(`- \`${t}\``);
  }
  if (report.risks.length > 0) {
    lines.push('');
    lines.push('## Common edit risks');
    for (const r of report.risks) {
      lines.push(`- **${r.kind}** (_${r.severity}_) — ${r.message}`);
    }
  }
  if (report.nextCommands.length > 0) {
    lines.push('');
    lines.push('## Next commands');
    for (const n of report.nextCommands) lines.push(`- \`${n}\``);
  }
  return lines.join('\n') + '\n';
}
