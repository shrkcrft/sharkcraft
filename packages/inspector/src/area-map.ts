import { existsSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const AREA_MAP_SCHEMA = 'sharkcraft.area-map/v1';

export enum AreaKind {
  Core = 'core',
  Common = 'common',
  Runtime = 'runtime',
  Kernel = 'kernel',
  Plugin = 'plugin',
  Adapter = 'adapter',
  Ui = 'ui',
  App = 'app',
  Api = 'api',
  Tests = 'tests',
  Docs = 'docs',
  Infra = 'infra',
  Generated = 'generated',
  Unknown = 'unknown',
}

export interface IAreaMapEntry {
  id: string;
  kind: AreaKind;
  paths: readonly string[];
  fileCount: number;
  /** Best-effort: import edges into this area (from import graph). */
  importsIn: number;
  /** Best-effort: import edges out of this area. */
  importsOut: number;
  boundaryRuleIds: readonly string[];
  relatedTemplateIds: readonly string[];
  relatedPipelineIds: readonly string[];
  /** 0–100; high when an area has many fan-in edges with weak guard-rails. */
  riskScore: number;
}

export interface IAreaMap {
  schema: typeof AREA_MAP_SCHEMA;
  projectRoot: string;
  areas: readonly IAreaMapEntry[];
  unclassifiedFiles: number;
}

const AREA_PATTERNS: Array<{ kind: AreaKind; match: RegExp[]; idHint: string }> = [
  { kind: AreaKind.Core, match: [/^packages\/core(\/|$)/, /^src\/core(\/|$)/], idHint: 'core' },
  { kind: AreaKind.Common, match: [/^packages\/(common|shared)(\/|$)/, /^src\/(common|shared)(\/|$)/], idHint: 'common' },
  { kind: AreaKind.Runtime, match: [/^packages\/runtime(\/|$)/, /^src\/runtime(\/|$)/], idHint: 'runtime' },
  { kind: AreaKind.Kernel, match: [/^packages\/kernel(\/|$)/, /^src\/kernel(\/|$)/], idHint: 'kernel' },
  { kind: AreaKind.Plugin, match: [/plugins?(\/|$)/, /^packages\/plugin-/], idHint: 'plugin' },
  { kind: AreaKind.Adapter, match: [/adapters?(\/|$)/, /^packages\/adapter-/], idHint: 'adapter' },
  { kind: AreaKind.Ui, match: [/^packages\/(ui|dashboard|web)(\/|$)/, /^(src|app)\/(ui|components|pages|views)(\/|$)/], idHint: 'ui' },
  { kind: AreaKind.App, match: [/^apps?\//, /^packages\/app(\/|$)/], idHint: 'app' },
  { kind: AreaKind.Api, match: [/^packages\/api(\/|$)/, /\/api\//, /\/routes\//, /\/controllers\//], idHint: 'api' },
  { kind: AreaKind.Tests, match: [/^tests?\//, /\.spec\.[tj]sx?$/, /\.test\.[tj]sx?$/, /\/__tests__\//], idHint: 'tests' },
  { kind: AreaKind.Docs, match: [/^docs?\//, /\.md$/], idHint: 'docs' },
  { kind: AreaKind.Infra, match: [/^(\.github|scripts|infra|docker|deploy)\//, /^Dockerfile/], idHint: 'infra' },
  { kind: AreaKind.Generated, match: [/\/dist\//, /\/generated\//, /\/build\//, /\.d\.ts$/], idHint: 'generated' },
];

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

function walk(root: string, base = ''): string[] {
  const out: string[] = [];
  const target = base ? nodePath.join(root, base) : root;
  let entries: string[];
  try {
    entries = readdirSync(target);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name.startsWith('.') && !['.github', '.gitlab'].includes(name)) continue;
    if (IGNORE_DIRS.has(name)) continue;
    const rel = base ? `${base}/${name}` : name;
    let stat;
    try {
      stat = statSync(nodePath.join(root, rel));
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      out.push(...walk(root, rel));
    } else if (stat.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function classify(file: string): AreaKind {
  for (const p of AREA_PATTERNS) {
    if (p.match.some((re) => re.test(file))) return p.kind;
  }
  return AreaKind.Unknown;
}

function packageOrTopSegment(file: string): string {
  const segs = file.split('/');
  if (segs[0] === 'packages' && segs[1]) return `packages/${segs[1]}`;
  if (segs[0] === 'apps' && segs[1]) return `apps/${segs[1]}`;
  return segs[0] ?? '';
}

export function buildAreaMap(inspection: ISharkcraftInspection): IAreaMap {
  const root = inspection.projectRoot;
  const allFiles = existsSync(root) ? walk(root) : [];

  const byKey = new Map<
    string,
    {
      kind: AreaKind;
      paths: Set<string>;
      fileCount: number;
    }
  >();

  let unclassified = 0;
  for (const f of allFiles) {
    const kind = classify(f);
    if (kind === AreaKind.Unknown) unclassified += 1;
    const seg = packageOrTopSegment(f);
    const key = `${kind}:${seg}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { kind, paths: new Set(), fileCount: 0 };
      byKey.set(key, entry);
    }
    entry.paths.add(seg);
    entry.fileCount += 1;
  }

  const boundaryRules = inspection.boundaryRegistry.list();
  const templates = inspection.templateRegistry.list();
  const pipelines = inspection.pipelineRegistry.list();

  const areas: IAreaMapEntry[] = [];
  for (const [key, info] of byKey) {
    const paths = [...info.paths].sort();
    const boundaryRuleIds = boundaryRules
      .filter((r) => paths.some((p) => (r.from ?? []).some((g) => p.includes(stripGlob(g)))))
      .map((r) => r.id);
    const relatedTemplateIds = templates
      .filter((t) => paths.some((p) => targetPathString(t).includes(p.split('/').pop() ?? '')))
      .map((t) => t.id);
    const relatedPipelineIds = pipelines
      .filter((p) =>
        paths.some((path) =>
          (p.steps ?? []).some((s) =>
            JSON.stringify(s).toLowerCase().includes(path.toLowerCase()),
          ),
        ),
      )
      .map((p) => p.id);
    areas.push({
      id: key,
      kind: info.kind,
      paths,
      fileCount: info.fileCount,
      importsIn: 0,
      importsOut: 0,
      boundaryRuleIds,
      relatedTemplateIds,
      relatedPipelineIds,
      riskScore: computeRiskScore({
        kind: info.kind,
        fileCount: info.fileCount,
        boundaryRules: boundaryRuleIds.length,
      }),
    });
  }

  areas.sort((a, b) => b.fileCount - a.fileCount);

  return {
    schema: AREA_MAP_SCHEMA,
    projectRoot: root,
    areas,
    unclassifiedFiles: unclassified,
  };
}

function stripGlob(s: string): string {
  return s.replace(/[*?]/g, '');
}

function targetPathString(t: { targetPath?: unknown }): string {
  const tp = t.targetPath;
  if (typeof tp === 'string') return tp;
  return '';
}

function computeRiskScore(input: {
  kind: AreaKind;
  fileCount: number;
  boundaryRules: number;
}): number {
  let score = 0;
  if (input.kind === AreaKind.Unknown) score += 30;
  if (input.kind === AreaKind.Generated) score -= 10;
  if (input.fileCount > 100) score += 15;
  if (input.fileCount > 25 && input.boundaryRules === 0) score += 20;
  if (input.boundaryRules > 3) score -= 10;
  return Math.max(0, Math.min(100, 30 + score));
}

export function renderAreaMapText(map: IAreaMap): string {
  const lines: string[] = [];
  lines.push(`Area map (${map.areas.length} areas, ${map.unclassifiedFiles} unclassified files)`);
  for (const a of map.areas.slice(0, 50)) {
    lines.push(
      `  ${a.kind.padEnd(10)} ${String(a.fileCount).padStart(5)} files  paths=${a.paths.join(', ')}  risk=${a.riskScore}`,
    );
  }
  return lines.join('\n');
}

export function renderAreaMapMarkdown(map: IAreaMap): string {
  const lines: string[] = [];
  lines.push(`# Repository area map`);
  lines.push('');
  lines.push(`Total areas: **${map.areas.length}** — unclassified files: ${map.unclassifiedFiles}.`);
  lines.push('');
  lines.push('| Kind | Files | Paths | Boundary rules | Risk |');
  lines.push('| --- | ---: | --- | ---: | ---: |');
  for (const a of map.areas) {
    lines.push(
      `| ${a.kind} | ${a.fileCount} | ${a.paths.join(', ')} | ${a.boundaryRuleIds.length} | ${a.riskScore} |`,
    );
  }
  return lines.join('\n') + '\n';
}
