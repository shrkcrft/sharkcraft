import { existsSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { AreaKind } from '@shrkcrft/core';
import { globToRegex } from '@shrkcrft/boundaries';
import type { ISharkCraftConfig } from '@shrkcrft/config';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

// The enum moved to core (so the config schema can validate a pattern's kind
// against it); re-exported here so every existing import keeps working.
export { AreaKind };

export const AREA_MAP_SCHEMA = 'sharkcraft.area-map/v1';

/** Below this share of classified files the map reports itself `degraded` (config: `areaMap.minClassificationRate`). */
export const DEFAULT_MIN_CLASSIFICATION_RATE = 0.5;

/** Unclassified paths named in the map — actionable, not a count alone. */
const UNCLASSIFIED_SAMPLE = 20;

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
  /** Files the map walked. `classifiedFiles + unclassifiedFiles === totalFiles`. */
  totalFiles: number;
  classifiedFiles: number;
  /** `classifiedFiles / totalFiles` (0..1; 0 when nothing was walked). */
  classificationRate: number;
  /** The rate `degraded` is judged against. */
  minClassificationRate: number;
  /**
   * True when fewer files classified than `minClassificationRate`. Every view
   * derived from the map (impact, review packets, the report site) inherits
   * the blind spot, so it reports this instead of silently understating.
   */
  degraded: boolean;
  /** The first unclassified paths, sorted — what `areaMap.patterns` should cover. */
  unclassifiedSample: readonly string[];
  /** Which pattern tables classified: the built-in layout table, project config, or both. */
  patternSource: 'built-in' | 'config' | 'config+built-in';
}

/** How one file classified, and which table decided. */
export interface IAreaClassification {
  readonly kind: AreaKind;
  /** The project pattern's `id`, when a config pattern with one matched. */
  readonly id?: string;
  readonly source: 'config' | 'built-in' | 'none';
}

type AreaMapConfig = NonNullable<ISharkCraftConfig['areaMap']>;

const AREA_PATTERNS: Array<{ kind: AreaKind; match: RegExp[]; idHint: string }> = [
  { kind: AreaKind.Core, match: [/^packages\/core(\/|$)/, /^src\/core(\/|$)/], idHint: 'core' },
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

/**
 * THE file → area classifier. The area map, impact's target attribution and
 * the changes summary's project-declared areas all go through it, so a
 * project pattern means the same thing everywhere.
 *
 * Project patterns (`areaMap.patterns`) run FIRST, in declared order; then the
 * built-in layout table, unless `replaceDefaults` (or `builtIns: false`, for a
 * caller that only wants the project's own taxonomy).
 */
export function createAreaClassifier(
  config?: AreaMapConfig | null,
  options: { readonly builtIns?: boolean } = {},
): (file: string) => IAreaClassification {
  const project = (config?.patterns ?? []).map((p) => ({
    kind: p.kind,
    ...(p.id ? { id: p.id } : {}),
    matchers: p.match.map((g) => globToRegex(g)),
  }));
  const useBuiltIns = options.builtIns !== false && config?.replaceDefaults !== true;
  return (file: string): IAreaClassification => {
    for (const p of project) {
      if (p.matchers.some((re) => re.test(file))) {
        return { kind: p.kind, ...(p.id ? { id: p.id } : {}), source: 'config' };
      }
    }
    if (useBuiltIns) {
      for (const p of AREA_PATTERNS) {
        if (p.match.some((re) => re.test(file))) return { kind: p.kind, source: 'built-in' };
      }
    }
    return { kind: AreaKind.Unknown, source: 'none' };
  };
}

function packageOrTopSegment(file: string): string {
  const segs = file.split('/');
  if (segs[0] === 'packages' && segs[1]) return `packages/${segs[1]}`;
  if (segs[0] === 'apps' && segs[1]) return `apps/${segs[1]}`;
  return segs[0] ?? '';
}

/**
 * THE area id of a classified file: `<kind>:<pattern id | package or top segment>`.
 *
 * `buildAreaMap` keys its entries with it, and every view asking "which area
 * is this file in" (impact's affected areas, `core-area`, boundary risks)
 * classifies the file and looks this id up. A prefix match on an entry's
 * `paths` cannot answer it: `paths` holds only the top segment, so a config
 * pattern for `libs/<group>/core/**` made EVERY `libs/…` file look core.
 */
export function areaIdOf(classification: IAreaClassification, file: string): string {
  return `${classification.kind}:${classification.id ?? packageOrTopSegment(file)}`;
}

function patternSourceOf(config?: AreaMapConfig | null): IAreaMap['patternSource'] {
  if ((config?.patterns?.length ?? 0) === 0) return config?.replaceDefaults === true ? 'config' : 'built-in';
  return config?.replaceDefaults === true ? 'config' : 'config+built-in';
}

export function buildAreaMap(inspection: ISharkcraftInspection): IAreaMap {
  const root = inspection.projectRoot;
  const config = inspection.config?.areaMap;
  const classify = createAreaClassifier(config);
  const allFiles = existsSync(root) ? walk(root) : [];

  const byKey = new Map<
    string,
    {
      kind: AreaKind;
      paths: Set<string>;
      fileCount: number;
    }
  >();

  const unclassifiedPaths: string[] = [];
  for (const f of allFiles) {
    const c = classify(f);
    if (c.kind === AreaKind.Unknown) unclassifiedPaths.push(f);
    const seg = packageOrTopSegment(f);
    const key = areaIdOf(c, f);
    let entry = byKey.get(key);
    if (!entry) {
      entry = { kind: c.kind, paths: new Set(), fileCount: 0 };
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

  const totalFiles = allFiles.length;
  const unclassifiedFiles = unclassifiedPaths.length;
  const classifiedFiles = totalFiles - unclassifiedFiles;
  const classificationRate = totalFiles === 0 ? 0 : Math.round((classifiedFiles / totalFiles) * 10_000) / 10_000;
  const minClassificationRate = config?.minClassificationRate ?? DEFAULT_MIN_CLASSIFICATION_RATE;
  return {
    schema: AREA_MAP_SCHEMA,
    projectRoot: root,
    areas,
    unclassifiedFiles,
    totalFiles,
    classifiedFiles,
    classificationRate,
    minClassificationRate,
    degraded: totalFiles > 0 && classificationRate < minClassificationRate,
    unclassifiedSample: [...unclassifiedPaths].sort().slice(0, UNCLASSIFIED_SAMPLE),
    patternSource: patternSourceOf(config),
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

/** `12.5%` — one formatting of a classification rate for every renderer. */
export function formatClassificationRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/** The loud line a degraded map earns — one wording across text, markdown and HTML. */
export function areaMapDegradedLine(map: IAreaMap): string | undefined {
  if (!map.degraded) return undefined;
  return (
    `area attribution degraded — ${formatClassificationRate(map.classificationRate)} of files classified ` +
    `(below ${formatClassificationRate(map.minClassificationRate)}); add areaMap.patterns to sharkcraft.config.ts`
  );
}

export function renderAreaMapText(map: IAreaMap): string {
  const lines: string[] = [];
  lines.push(`Area map (${map.areas.length} areas, ${map.unclassifiedFiles} unclassified files)`);
  lines.push(
    `  classified ${map.classifiedFiles}/${map.totalFiles} (${formatClassificationRate(map.classificationRate)}) · patterns: ${map.patternSource}`,
  );
  const degraded = areaMapDegradedLine(map);
  if (degraded) {
    lines.push(`  ! ${degraded}`);
    if (map.unclassifiedSample.length > 0) {
      lines.push(`    unclassified (first ${map.unclassifiedSample.length}): ${map.unclassifiedSample.join(', ')}`);
    }
  }
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
  lines.push(
    `Classified: **${map.classifiedFiles}/${map.totalFiles}** (${formatClassificationRate(map.classificationRate)}) · patterns: ${map.patternSource}.`,
  );
  const degraded = areaMapDegradedLine(map);
  if (degraded) {
    lines.push('');
    lines.push(`> **Warning:** ${degraded}.`);
    if (map.unclassifiedSample.length > 0) {
      lines.push(`> Unclassified (first ${map.unclassifiedSample.length}): ${map.unclassifiedSample.map((p) => `\`${p}\``).join(', ')}`);
    }
  }
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
