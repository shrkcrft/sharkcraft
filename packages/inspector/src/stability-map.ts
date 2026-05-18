import { existsSync, readFileSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { findFiles } from '@shrkcrft/workspace';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import type { IImportGraphAnalysis } from './import-graph-analysis.ts';
import { AreaKind, type IAreaMap } from './area-map.ts';

export const STABILITY_MAP_SCHEMA = 'sharkcraft.stability-map/v1';

export enum StabilityKind {
  Stable = 'stable',
  Experimental = 'experimental',
  Deprecated = 'deprecated',
  Legacy = 'legacy',
  Generated = 'generated',
  Internal = 'internal',
  PublicApi = 'public-api',
  HighRisk = 'high-risk',
}

export interface IStabilityArea {
  id: string;
  path: string;
  kind: StabilityKind;
  /** Confidence the classification is correct. */
  confidence: 'high' | 'medium' | 'low';
  /** Signals that led to the classification. */
  signals: readonly string[];
  /** Fan-in (number of importers) when available. */
  fanIn?: number;
  /** Number of files in the area. */
  fileCount: number;
  /** Free-form note. */
  note?: string;
}

export interface IStabilityMap {
  schema: typeof STABILITY_MAP_SCHEMA;
  projectRoot: string;
  areas: readonly IStabilityArea[];
  /** Index by kind for cheap lookups. */
  byKind: Readonly<Record<StabilityKind, readonly IStabilityArea[]>>;
  /** Limitations / sampling notes. */
  limitations: readonly string[];
}

export interface IBuildStabilityMapOptions {
  inspection: ISharkcraftInspection;
  areaMap?: IAreaMap;
  importGraph?: IImportGraphAnalysis;
  /** Names of generated roots (relative paths) — areas under these are marked Generated. */
  generatedRoots?: readonly string[];
  /** Fan-in threshold above which an area is also flagged HighRisk. */
  highFanInThreshold?: number;
  /** Scan file contents for `@deprecated` / `@experimental` / Java `@Deprecated` / C# `[Obsolete]` / Rust `#[deprecated]` / Go `Deprecated:` / Python `warnings.warn(..., DeprecationWarning)`. Off by default for speed; on at depth>=deep. */
  scanAnnotations?: boolean;
  /** Max files to scan when annotation scan is enabled. Default 1000. */
  annotationScanLimit?: number;
  /** Max bytes per file to scan for annotations. Default 8192. */
  annotationScanBytes?: number;
  /** Include git-age signal — files older than this many days bias toward Stable; newer than this many days bias toward Experimental. Optional. */
  gitAgeOldDays?: number;
  gitAgeNewDays?: number;
}

const STABILITY_HINTS: ReadonlyArray<{
  re: RegExp;
  kind: StabilityKind;
  confidence: 'high' | 'medium' | 'low';
  signal: string;
}> = [
  { re: /(^|\/)deprecated($|\/)/i, kind: StabilityKind.Deprecated, confidence: 'high', signal: 'folder named "deprecated"' },
  { re: /(^|\/)legacy($|\/)/i, kind: StabilityKind.Legacy, confidence: 'high', signal: 'folder named "legacy"' },
  { re: /(^|\/)old($|\/)/i, kind: StabilityKind.Legacy, confidence: 'medium', signal: 'folder named "old"' },
  { re: /(^|\/)experimental($|\/)/i, kind: StabilityKind.Experimental, confidence: 'high', signal: 'folder named "experimental"' },
  { re: /(^|\/)playground($|\/)/i, kind: StabilityKind.Experimental, confidence: 'medium', signal: 'folder named "playground"' },
  { re: /(^|\/)preview($|\/)/i, kind: StabilityKind.Experimental, confidence: 'medium', signal: 'folder named "preview"' },
  { re: /(^|\/)internal($|\/)/i, kind: StabilityKind.Internal, confidence: 'high', signal: 'folder named "internal"' },
  { re: /(^|\/)private($|\/)/i, kind: StabilityKind.Internal, confidence: 'medium', signal: 'folder named "private"' },
  { re: /(^|\/)public($|\/)/i, kind: StabilityKind.PublicApi, confidence: 'high', signal: 'folder named "public"' },
  { re: /(^|\/)api($|\/)/i, kind: StabilityKind.PublicApi, confidence: 'medium', signal: 'folder named "api"' },
  { re: /(^|\/)public-api($|\/)/i, kind: StabilityKind.PublicApi, confidence: 'high', signal: 'folder named "public-api"' },
];

const DEFAULT_HIGH_FAN_IN = 12;
const DEFAULT_ANNOTATION_SCAN_LIMIT = 1000;
const DEFAULT_ANNOTATION_BYTES = 8192;

interface IAnnotationVote {
  kind: StabilityKind;
  confidence: 'high' | 'medium' | 'low';
  signal: string;
}

/** Detect deprecation / experimentality / internal-API annotations across languages. Returns at most one vote per signal kind. */
function detectFileAnnotations(file: string, content: string): readonly IAnnotationVote[] {
  const out: IAnnotationVote[] = [];
  const ext = nodePath.extname(file).toLowerCase();
  // JSDoc / TSDoc — applies to TS/JS/CSS-in-JS-ish.
  if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i.test(file)) {
    if (/@deprecated\b/.test(content)) out.push({ kind: StabilityKind.Deprecated, confidence: 'high', signal: '@deprecated JSDoc tag' });
    if (/@experimental\b/.test(content)) out.push({ kind: StabilityKind.Experimental, confidence: 'high', signal: '@experimental JSDoc tag' });
    if (/@internal\b/.test(content)) out.push({ kind: StabilityKind.Internal, confidence: 'medium', signal: '@internal JSDoc tag' });
    if (/@public\b/.test(content) || /@beta\b/.test(content) || /@alpha\b/.test(content)) {
      out.push({ kind: StabilityKind.PublicApi, confidence: 'low', signal: '@public/@beta/@alpha tag' });
    }
  }
  // Java — `@Deprecated`, `@org.springframework.lang.Experimental`-ish, `@Internal`.
  if (ext === '.java') {
    if (/^\s*@Deprecated\b/m.test(content) || /@java\.lang\.Deprecated\b/.test(content)) {
      out.push({ kind: StabilityKind.Deprecated, confidence: 'high', signal: 'Java @Deprecated annotation' });
    }
    if (/@Experimental\b/.test(content)) out.push({ kind: StabilityKind.Experimental, confidence: 'medium', signal: '@Experimental annotation' });
    if (/@Internal\b/.test(content)) out.push({ kind: StabilityKind.Internal, confidence: 'medium', signal: '@Internal annotation' });
  }
  // C# — `[Obsolete]`, `[EditorBrowsable(Never)]`-ish.
  if (ext === '.cs') {
    if (/^\s*\[Obsolete\b/m.test(content) || /System\.Obsolete\b/.test(content)) {
      out.push({ kind: StabilityKind.Deprecated, confidence: 'high', signal: '[Obsolete] attribute' });
    }
    if (/\[EditorBrowsable\s*\(\s*EditorBrowsableState\.Never\s*\)\]/.test(content)) {
      out.push({ kind: StabilityKind.Internal, confidence: 'medium', signal: '[EditorBrowsable(Never)] attribute' });
    }
  }
  // Python — `warnings.warn(..., DeprecationWarning)`, `# DEPRECATED`.
  if (ext === '.py') {
    if (/warnings\.warn\s*\([^)]*DeprecationWarning/m.test(content)) {
      out.push({ kind: StabilityKind.Deprecated, confidence: 'high', signal: 'warnings.warn(..., DeprecationWarning)' });
    }
    if (/^\s*#\s*DEPRECATED\b/m.test(content)) {
      out.push({ kind: StabilityKind.Deprecated, confidence: 'medium', signal: 'DEPRECATED comment' });
    }
    if (/^\s*#\s*EXPERIMENTAL\b/m.test(content)) {
      out.push({ kind: StabilityKind.Experimental, confidence: 'medium', signal: 'EXPERIMENTAL comment' });
    }
  }
  // Rust — `#[deprecated]`, `#[doc(hidden)]`.
  if (ext === '.rs') {
    if (/#\[\s*deprecated\b/.test(content)) out.push({ kind: StabilityKind.Deprecated, confidence: 'high', signal: '#[deprecated] attribute' });
    if (/#\[\s*doc\s*\(\s*hidden\s*\)\s*\]/.test(content)) {
      out.push({ kind: StabilityKind.Internal, confidence: 'medium', signal: '#[doc(hidden)] attribute' });
    }
    if (/#\[\s*unstable\b/.test(content)) out.push({ kind: StabilityKind.Experimental, confidence: 'medium', signal: '#[unstable] attribute' });
  }
  // Go — `// Deprecated:` convention.
  if (ext === '.go') {
    if (/^\s*\/\/\s*Deprecated\s*:/m.test(content)) {
      out.push({ kind: StabilityKind.Deprecated, confidence: 'high', signal: '// Deprecated: comment' });
    }
  }
  return out;
}

export function buildStabilityMap(
  options: IBuildStabilityMapOptions,
): IStabilityMap {
  const inspection = options.inspection;
  const projectRoot = inspection.projectRoot;
  const limitations: string[] = [];
  const highFanInThreshold = options.highFanInThreshold ?? DEFAULT_HIGH_FAN_IN;

  const generatedSet = new Set((options.generatedRoots ?? []).map((p) => p.replace(/\/$/, '')));

  const buckets = new Map<string, {
    signals: Set<string>;
    kindVotes: Map<StabilityKind, number>;
    confidenceVotes: Map<string, number>;
    fileCount: number;
  }>();

  const recordBucket = (dir: string): typeof buckets extends Map<string, infer V> ? V : never => {
    let bucket = buckets.get(dir);
    if (!bucket) {
      bucket = {
        signals: new Set(),
        kindVotes: new Map(),
        confidenceVotes: new Map(),
        fileCount: 0,
      };
      buckets.set(dir, bucket);
    }
    return bucket;
  };

  // Walk source files; for each, derive the most-specific containing dir
  // up to 4 segments deep. Sum up signals.
  const repoFiles = enumerateRepoFiles(inspection);
  for (const file of repoFiles) {
    const rel = file;
    const parts = rel.split('/');
    for (let i = 1; i <= Math.min(parts.length - 1, 4); i += 1) {
      const dir = parts.slice(0, i).join('/');
      const bucket = recordBucket(dir);
      bucket.fileCount += 1;
      for (const hint of STABILITY_HINTS) {
        if (hint.re.test('/' + dir + '/')) {
          bucket.signals.add(hint.signal);
          bucket.kindVotes.set(hint.kind, (bucket.kindVotes.get(hint.kind) ?? 0) + 1);
          bucket.confidenceVotes.set(hint.confidence, (bucket.confidenceVotes.get(hint.confidence) ?? 0) + 1);
        }
      }
      for (const root of generatedSet) {
        if (dir === root || dir.startsWith(root + '/')) {
          bucket.signals.add(`under generated root "${root}"`);
          bucket.kindVotes.set(StabilityKind.Generated, (bucket.kindVotes.get(StabilityKind.Generated) ?? 0) + 1);
          bucket.confidenceVotes.set('high', (bucket.confidenceVotes.get('high') ?? 0) + 1);
        }
      }
    }
  }

  // Optional in-file annotation scan. Per-file annotations vote for the
  // file's immediate directory (parent of the file) — finer-grained than
  // folder-name heuristics.
  if (options.scanAnnotations) {
    const scanLimit = options.annotationScanLimit ?? DEFAULT_ANNOTATION_SCAN_LIMIT;
    const scanBytes = options.annotationScanBytes ?? DEFAULT_ANNOTATION_BYTES;
    let scanned = 0;
    let scanFailures = 0;
    const ANNOTATABLE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|java|cs|py|rs|go)$/i;
    for (const file of repoFiles) {
      if (scanned >= scanLimit) break;
      if (!ANNOTATABLE.test(file)) continue;
      const abs = nodePath.isAbsolute(file) ? file : nodePath.join(projectRoot, file);
      let head = '';
      try {
        if (existsSync(abs) && statSync(abs).isFile()) {
          const buf = readFileSync(abs);
          head = buf.slice(0, scanBytes).toString('utf8');
          scanned += 1;
        } else {
          continue;
        }
      } catch {
        scanFailures += 1;
        continue;
      }
      const votes = detectFileAnnotations(file, head);
      if (votes.length === 0) continue;
      const dir = nodePath.dirname(file);
      const bucket = recordBucket(dir);
      for (const vote of votes) {
        bucket.signals.add(vote.signal);
        bucket.kindVotes.set(vote.kind, (bucket.kindVotes.get(vote.kind) ?? 0) + 1);
        bucket.confidenceVotes.set(vote.confidence, (bucket.confidenceVotes.get(vote.confidence) ?? 0) + 1);
      }
    }
    if (scanned >= scanLimit) {
      limitations.push(`Annotation scan limited to ${scanLimit} files; some markers may be missed.`);
    }
    if (scanFailures > 0) {
      limitations.push(`${scanFailures} file(s) skipped during annotation scan due to read errors.`);
    }
  }

  // Compute fan-in per directory using the import graph's `topFanIn` list.
  const fanInByPath = new Map<string, number>();
  if (options.importGraph) {
    for (const entry of options.importGraph.topFanIn) {
      const file = normalizePath(entry.file);
      // Roll the file's fan-in up into each ancestor directory bucket.
      const parts = file.split('/');
      for (let i = 1; i <= Math.min(parts.length - 1, 4); i += 1) {
        const dir = parts.slice(0, i).join('/');
        fanInByPath.set(dir, (fanInByPath.get(dir) ?? 0) + entry.in);
      }
    }
  }

  // Collect public-api hints from index.ts presence + export barrels.
  for (const file of repoFiles) {
    if (!/(?:^|\/)index\.(ts|tsx|js|mjs)$/i.test(file)) continue;
    const dir = nodePath.dirname(file);
    const bucket = recordBucket(dir);
    bucket.signals.add('index barrel present (potential public API)');
    bucket.kindVotes.set(StabilityKind.PublicApi, (bucket.kindVotes.get(StabilityKind.PublicApi) ?? 0) + 1);
  }

  const areas: IStabilityArea[] = [];
  for (const [dir, info] of buckets) {
    if (info.fileCount === 0) continue;
    if (info.kindVotes.size === 0 && !generatedSet.has(dir)) continue;

    // Choose the kind with the highest votes.
    let chosenKind: StabilityKind | undefined;
    let chosenVotes = 0;
    for (const [k, v] of info.kindVotes) {
      if (v > chosenVotes) {
        chosenKind = k;
        chosenVotes = v;
      }
    }
    if (!chosenKind) continue;

    const confidence: 'high' | 'medium' | 'low' = chooseConfidence(info.confidenceVotes);

    const fanIn = fanInByPath.get(dir);

    areas.push({
      id: `${chosenKind}:${dir}`,
      path: dir,
      kind: chosenKind,
      confidence,
      signals: Array.from(info.signals),
      ...(typeof fanIn === 'number' ? { fanIn } : {}),
      fileCount: info.fileCount,
    });

    if (typeof fanIn === 'number' && fanIn >= highFanInThreshold && chosenKind !== StabilityKind.HighRisk) {
      areas.push({
        id: `${StabilityKind.HighRisk}:${dir}`,
        path: dir,
        kind: StabilityKind.HighRisk,
        confidence: 'medium',
        signals: Array.from(info.signals).concat([`fan-in ≥ ${highFanInThreshold}`]),
        fanIn,
        fileCount: info.fileCount,
        note: 'High fan-in — changes here may cascade.',
      });
    }
  }

  // If area-map gives us hints, fold them in (lightweight).
  if (options.areaMap) {
    for (const entry of options.areaMap.areas) {
      if (entry.kind === AreaKind.Generated) {
        for (const path of entry.paths) {
          if (!areas.some((a) => a.path === path && a.kind === StabilityKind.Generated)) {
            areas.push({
              id: `${StabilityKind.Generated}:${path}`,
              path,
              kind: StabilityKind.Generated,
              confidence: 'high',
              signals: ['area-map kind=generated'],
              fileCount: 0,
            });
          }
        }
      }
    }
  }

  if (!options.importGraph) {
    limitations.push('No import graph supplied — fan-in heuristics skipped.');
  }
  if (areas.length === 0) {
    limitations.push('No stability signals detected; treat the whole repo as default-stable.');
  }

  const byKind = {
    [StabilityKind.Stable]: areas.filter((a) => a.kind === StabilityKind.Stable),
    [StabilityKind.Experimental]: areas.filter((a) => a.kind === StabilityKind.Experimental),
    [StabilityKind.Deprecated]: areas.filter((a) => a.kind === StabilityKind.Deprecated),
    [StabilityKind.Legacy]: areas.filter((a) => a.kind === StabilityKind.Legacy),
    [StabilityKind.Generated]: areas.filter((a) => a.kind === StabilityKind.Generated),
    [StabilityKind.Internal]: areas.filter((a) => a.kind === StabilityKind.Internal),
    [StabilityKind.PublicApi]: areas.filter((a) => a.kind === StabilityKind.PublicApi),
    [StabilityKind.HighRisk]: areas.filter((a) => a.kind === StabilityKind.HighRisk),
  } as const;

  return {
    schema: STABILITY_MAP_SCHEMA,
    projectRoot,
    areas,
    byKind,
    limitations,
  };
}

function enumerateRepoFiles(inspection: ISharkcraftInspection): readonly string[] {
  const found = findFiles(inspection.projectRoot, /\.(ts|tsx|js|jsx|mjs|cjs|go|py|rs|cs|java|kt|swift|d\.ts)$/i, { maxDepth: 6 });
  const rel = found.map((f) => nodePath.relative(inspection.projectRoot, f));
  const set = new Set(rel);
  for (const f of inspection.sourceFiles) {
    if (nodePath.isAbsolute(f)) {
      const r = nodePath.relative(inspection.projectRoot, f);
      if (r.startsWith('..')) continue;
      if (r.includes('node_modules')) continue;
      set.add(r);
    } else {
      if (f.includes('node_modules')) continue;
      set.add(f);
    }
  }
  return Array.from(set).sort();
}

function chooseConfidence(votes: Map<string, number>): 'high' | 'medium' | 'low' {
  if ((votes.get('high') ?? 0) > 0) return 'high';
  if ((votes.get('medium') ?? 0) > 0) return 'medium';
  return 'low';
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/$/, '');
}

export function renderStabilityMapText(map: IStabilityMap): string {
  const lines: string[] = [];
  lines.push('=== Stability map ===');
  for (const kind of Object.values(StabilityKind)) {
    const list = map.byKind[kind];
    lines.push(`  ${kind.padEnd(14)} ${list.length}`);
  }
  if (map.areas.length === 0) {
    lines.push('');
    lines.push('No stability-classified areas found.');
    return lines.join('\n');
  }
  lines.push('');
  for (const kind of Object.values(StabilityKind)) {
    const list = map.byKind[kind];
    if (list.length === 0) continue;
    lines.push(`${kind}:`);
    for (const area of list.slice(0, 12)) {
      const fan = typeof area.fanIn === 'number' ? `  fan-in=${area.fanIn}` : '';
      lines.push(`  - ${area.path}  [${area.confidence}]  files=${area.fileCount}${fan}`);
    }
    if (list.length > 12) lines.push(`  ... ${list.length - 12} more`);
    lines.push('');
  }
  if (map.limitations.length > 0) {
    lines.push('Limitations:');
    for (const l of map.limitations) lines.push(`  - ${l}`);
  }
  return lines.join('\n');
}

export function renderStabilityMapMarkdown(map: IStabilityMap): string {
  const lines: string[] = [];
  lines.push('# Stability map');
  lines.push('');
  lines.push('| Kind | Areas |');
  lines.push('|---|---|');
  for (const kind of Object.values(StabilityKind)) {
    lines.push(`| ${kind} | ${map.byKind[kind].length} |`);
  }
  if (map.areas.length === 0) {
    lines.push('');
    lines.push('_No stability-classified areas detected._');
    return lines.join('\n');
  }
  lines.push('');
  for (const kind of Object.values(StabilityKind)) {
    const list = map.byKind[kind];
    if (list.length === 0) continue;
    lines.push(`## ${kind}`);
    lines.push('');
    lines.push('| Path | Confidence | Files | Fan-in | Signals |');
    lines.push('|---|---|---|---|---|');
    for (const area of list) {
      const fan = typeof area.fanIn === 'number' ? String(area.fanIn) : '-';
      lines.push(`| \`${area.path}\` | ${area.confidence} | ${area.fileCount} | ${fan} | ${area.signals.join('; ')} |`);
    }
    lines.push('');
  }
  if (map.limitations.length > 0) {
    lines.push('## Limitations');
    lines.push('');
    for (const l of map.limitations) lines.push(`- ${l}`);
  }
  return lines.join('\n');
}

export function renderStabilityMapJson(map: IStabilityMap): string {
  return JSON.stringify(map, null, 2);
}

export function getStabilityArea(map: IStabilityMap, id: string): IStabilityArea | undefined {
  return map.areas.find((a) => a.id === id || a.path === id);
}
