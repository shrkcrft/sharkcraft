import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { scanImports } from '@shrkcrft/boundaries';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { listConstructs } from './construct-registry.ts';

export const CONSTRUCT_INFERENCE_SCHEMA = 'sharkcraft.construct-inference/v1';

export enum InferredConstructConfidence {
  High = 'high',
  Medium = 'medium',
  Low = 'low',
}

export interface IInferredConstructFacet {
  kind: string;
  value: string;
  evidence: string;
}

export interface IInferredConstruct {
  id: string;
  type: string;
  title: string;
  confidence: InferredConstructConfidence;
  evidence: readonly string[];
  files: readonly string[];
  publicApi: readonly string[];
  events?: readonly string[];
  tokens?: readonly string[];
  relatedTemplates?: readonly string[];
  relatedPipelines?: readonly string[];
  relatedPathConventions?: readonly string[];
  facets?: readonly IInferredConstructFacet[];
  /** Pretty-printed `defineConstruct({...})` source. */
  draft: string;
}

export interface IConstructInferenceInput {
  type?: string;
  minConfidence?: InferredConstructConfidence;
  limit?: number;
}

export interface IConstructInferenceResult {
  schema: typeof CONSTRUCT_INFERENCE_SCHEMA;
  generatedAt: string;
  projectRoot: string;
  candidates: readonly IInferredConstruct[];
  warnings: readonly string[];
}

interface IFolderHint {
  /** Folder name → construct type. */
  match: RegExp;
  type: string;
  title: (root: string, name: string) => string;
  confidence: InferredConstructConfidence;
}

const FOLDER_HINTS: readonly IFolderHint[] = [
  { match: /(^|\/)services?($|\/)/, type: 'service', title: (_r, n) => `${n} service`, confidence: InferredConstructConfidence.High },
  { match: /(^|\/)plugins?($|\/)/, type: 'plugin', title: (_r, n) => `${n} plugin`, confidence: InferredConstructConfidence.High },
  { match: /(^|\/)policies?($|\/)/, type: 'policy', title: (_r, n) => `${n} policy`, confidence: InferredConstructConfidence.High },
  { match: /(^|\/)capabilities?($|\/)/, type: 'capability', title: (_r, n) => `${n} capability`, confidence: InferredConstructConfidence.High },
  { match: /(^|\/)adapters?($|\/)/, type: 'adapter', title: (_r, n) => `${n} adapter`, confidence: InferredConstructConfidence.Medium },
  { match: /(^|\/)(routes?|controllers?)($|\/)/, type: 'route', title: (_r, n) => `${n} route`, confidence: InferredConstructConfidence.Medium },
  { match: /(^|\/)components?($|\/)/, type: 'component', title: (_r, n) => `${n} component`, confidence: InferredConstructConfidence.Medium },
  { match: /(^|\/)features?($|\/)/, type: 'feature', title: (_r, n) => `${n} feature`, confidence: InferredConstructConfidence.Medium },
  { match: /(^|\/)modules?($|\/)/, type: 'module', title: (_r, n) => `${n} module`, confidence: InferredConstructConfidence.Low },
];

const FILE_SUFFIX_HINTS: readonly { suffix: RegExp; type: string; title: (n: string) => string; confidence: InferredConstructConfidence }[] = [
  { suffix: /\.service\.(ts|tsx|js)$/, type: 'service', title: (n) => `${n} service`, confidence: InferredConstructConfidence.High },
  { suffix: /\.plugin\.(ts|tsx|js)$/, type: 'plugin', title: (n) => `${n} plugin`, confidence: InferredConstructConfidence.High },
  { suffix: /\.policy\.(ts|tsx|js)$/, type: 'policy', title: (n) => `${n} policy`, confidence: InferredConstructConfidence.High },
  { suffix: /\.controller\.(ts|tsx|js)$/, type: 'controller', title: (n) => `${n} controller`, confidence: InferredConstructConfidence.Medium },
  { suffix: /\.adapter\.(ts|tsx|js)$/, type: 'adapter', title: (n) => `${n} adapter`, confidence: InferredConstructConfidence.Medium },
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
  '.next',
  'coverage',
]);

function walk(root: string, current = ''): string[] {
  const out: string[] = [];
  const dir = current ? nodePath.join(root, current) : root;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name.startsWith('.') && name !== '.github') continue;
    if (IGNORE_DIRS.has(name)) continue;
    const rel = current ? `${current}/${name}` : name;
    let stat;
    try {
      stat = statSync(nodePath.join(root, rel));
    } catch {
      continue;
    }
    if (stat.isDirectory()) out.push(...walk(root, rel));
    else if (stat.isFile()) out.push(rel);
  }
  return out;
}

function basenameNoExt(file: string): string {
  const base = file.split('/').pop() ?? file;
  const dotIdx = base.indexOf('.');
  return dotIdx >= 0 ? base.slice(0, dotIdx) : base;
}

function kebabize(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();
}

interface ICandidateBuilder {
  type: string;
  baseId: string;
  title: string;
  files: Set<string>;
  publicApi: Set<string>;
  evidence: Set<string>;
  events: Set<string>;
  tokens: Set<string>;
  confidence: InferredConstructConfidence;
}

function newBuilder(type: string, baseId: string, title: string, confidence: InferredConstructConfidence): ICandidateBuilder {
  return {
    type,
    baseId,
    title,
    files: new Set(),
    publicApi: new Set(),
    evidence: new Set(),
    events: new Set(),
    tokens: new Set(),
    confidence,
  };
}

function safeId(s: string): string {
  return s.replace(/[^a-z0-9-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

/** Extract simple string-constant style events/tokens from a file. */
function scanFacets(absPath: string): { events: string[]; tokens: string[] } {
  const events: string[] = [];
  const tokens: string[] = [];
  let text: string;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch {
    return { events, tokens };
  }
  // Event-like: 'foo.bar' / "foo.bar" with a dot in the middle.
  const evRe = /['"`]([a-z0-9_-]+(?:\.[a-z0-9_-]+){1,3})['"`]/gi;
  let m: RegExpExecArray | null;
  while ((m = evRe.exec(text)) !== null) {
    const val = m[1]!;
    if (/^[a-z0-9_-]+\.[a-z0-9_-]+/i.test(val) && val.length < 60) {
      events.push(val);
    }
  }
  // Token-like: UPPER_SNAKE_CASE identifiers exported or referenced.
  const tokRe = /\b([A-Z][A-Z0-9_]{3,})\b/g;
  while ((m = tokRe.exec(text)) !== null) {
    tokens.push(m[1]!);
  }
  return {
    events: [...new Set(events)].slice(0, 6),
    tokens: [...new Set(tokens)].slice(0, 6),
  };
}

function buildPublicApi(files: readonly string[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const base = f.split('/').pop() ?? '';
    if (base === 'index.ts' || base === 'index.tsx' || base === 'index.js') {
      out.push(f);
    }
    if (/\.public\.(ts|tsx|js)$/.test(base)) out.push(f);
  }
  return [...new Set(out)];
}

function relatedAssets(
  inspection: ISharkcraftInspection,
  files: readonly string[],
): {
  templates: string[];
  pipelines: string[];
  pathConventions: string[];
} {
  const templates = new Set<string>();
  const pipelines = new Set<string>();
  const paths = new Set<string>();
  // Templates with targetPath overlap.
  for (const t of inspection.templateRegistry.list()) {
    const tp = (t as unknown as { targetPath?: unknown }).targetPath;
    const pathLike = typeof tp === 'string' ? tp : '';
    if (!pathLike) continue;
    if (files.some((f) => f.includes(pathLike) || pathLike.includes(f.split('/').pop() ?? ''))) {
      templates.add(t.id);
    }
  }
  // Pipelines that mention these files (heuristic).
  for (const p of inspection.pipelineRegistry.list()) {
    const blob = JSON.stringify(p.steps ?? []).toLowerCase();
    if (files.some((f) => blob.includes(f.toLowerCase()))) pipelines.add(p.id);
  }
  // Path conventions covering folders.
  for (const p of inspection.pathService.list()) {
    const meta = (p.metadata ?? {}) as { path?: string };
    const segment = (meta.path ?? '').replace(/\*+/g, '');
    if (!segment) continue;
    if (files.some((f) => f.includes(segment))) paths.add(p.id);
  }
  return {
    templates: [...templates].sort(),
    pipelines: [...pipelines].sort(),
    pathConventions: [...paths].sort(),
  };
}

function buildDraft(c: IInferredConstruct): string {
  const lines: string[] = [];
  lines.push(`defineConstruct({`);
  lines.push(`  id: '${c.id}',`);
  lines.push(`  type: '${c.type}',`);
  lines.push(`  title: '${c.title.replace(/'/g, "\\'")}',`);
  lines.push(`  description: 'Inferred (${c.confidence} confidence). Replace with a real description.',`);
  if (c.files.length) {
    lines.push('  files: [');
    for (const f of c.files.slice(0, 12)) lines.push(`    '${f}',`);
    lines.push('  ],');
  }
  if (c.publicApi.length) {
    lines.push('  publicApi: [');
    for (const a of c.publicApi.slice(0, 8)) lines.push(`    '${a}',`);
    lines.push('  ],');
  }
  if (c.events?.length) {
    lines.push(`  events: [${c.events.map((e) => `'${e}'`).join(', ')}],`);
  }
  if (c.tokens?.length) {
    lines.push(`  tokens: [${c.tokens.map((e) => `'${e}'`).join(', ')}],`);
  }
  if (c.relatedTemplates?.length) {
    lines.push(`  relatedTemplates: [${c.relatedTemplates.map((e) => `'${e}'`).join(', ')}],`);
  }
  if (c.relatedPipelines?.length) {
    lines.push(`  relatedPipelines: [${c.relatedPipelines.map((e) => `'${e}'`).join(', ')}],`);
  }
  if (c.relatedPathConventions?.length) {
    lines.push(`  relatedPathConventions: [${c.relatedPathConventions.map((e) => `'${e}'`).join(', ')}],`);
  }
  lines.push(`}),`);
  return lines.join('\n');
}

function confidenceRank(c: InferredConstructConfidence): number {
  if (c === InferredConstructConfidence.High) return 3;
  if (c === InferredConstructConfidence.Medium) return 2;
  return 1;
}

export async function inferConstructs(
  inspection: ISharkcraftInspection,
  input: IConstructInferenceInput = {},
): Promise<IConstructInferenceResult> {
  const warnings: string[] = [];
  const builders = new Map<string, ICandidateBuilder>();
  const projectRoot = inspection.projectRoot;
  const allFiles = existsSync(projectRoot) ? walk(projectRoot) : [];

  // Pass 1: folder + filename hints.
  for (const file of allFiles) {
    if (!/\.(ts|tsx|js|jsx)$/.test(file)) continue;
    if (file.includes('.spec.') || file.includes('.test.') || file.includes('__tests__/')) {
      continue;
    }
    // Filename suffix hints (e.g. user.service.ts).
    const base = file.split('/').pop() ?? '';
    let matched = false;
    for (const fh of FILE_SUFFIX_HINTS) {
      if (fh.suffix.test(base)) {
        const name = base.replace(fh.suffix, '');
        const id = `${fh.type}.${safeId(kebabize(name))}`;
        let b = builders.get(id);
        if (!b) {
          b = newBuilder(fh.type, id, fh.title(name), fh.confidence);
          builders.set(id, b);
        }
        b.files.add(file);
        b.evidence.add(`filename matches /${fh.suffix.source}/`);
        matched = true;
      }
    }
    if (matched) continue;
    // Folder hints.
    for (const fh of FOLDER_HINTS) {
      if (!fh.match.test(file)) continue;
      // Group by parent folder under the matched segment.
      const segments = file.split('/');
      const matchIdx = segments.findIndex((s) => fh.match.test('/' + s + '/'));
      if (matchIdx < 0 || matchIdx + 1 >= segments.length) continue;
      const next = segments[matchIdx + 1]!;
      // If `next` is also the filename, use the bare name; otherwise treat the folder as the group.
      const group = next.includes('.') ? basenameNoExt(next) : next;
      const id = `${fh.type}.${safeId(kebabize(group))}`;
      let b = builders.get(id);
      if (!b) {
        b = newBuilder(fh.type, id, fh.title(projectRoot, group), fh.confidence);
        builders.set(id, b);
      }
      b.files.add(file);
      b.evidence.add(`folder matches ${fh.match.source}`);
      break;
    }
  }

  // Pass 2: aggregate by import-graph clusters around publicApi candidates.
  try {
    const scan = scanImports({ projectRoot });
    const importsByTarget = new Map<string, Set<string>>();
    for (const e of scan.edges) {
      if (e.kind !== 'internal') continue;
      if (!e.importSpecifier.startsWith('.')) continue;
      const target = nodePath.posix.normalize(
        nodePath.posix.join(nodePath.posix.dirname(e.from), e.importSpecifier),
      );
      const set = importsByTarget.get(target) ?? new Set<string>();
      set.add(e.from);
      importsByTarget.set(target, set);
    }
    for (const b of builders.values()) {
      // Add files that import any of the builder's files as "publicApi" hints.
      for (const f of [...b.files]) {
        const target = f.replace(/\.(ts|tsx|js|jsx)$/, '');
        for (const t of [target, target + '.ts', target + '.tsx', target + '/index.ts']) {
          const importers = importsByTarget.get(t);
          if (!importers) continue;
          if (importers.size > 0) {
            b.publicApi.add(f);
            b.evidence.add(`imported by ${importers.size} file(s)`);
          }
        }
      }
    }
  } catch {
    warnings.push('Import graph scan failed; some confidence hints unavailable.');
  }

  // Pass 3: facet detection (events/tokens).
  for (const b of builders.values()) {
    for (const f of [...b.files].slice(0, 8)) {
      const abs = nodePath.join(projectRoot, f);
      const facets = scanFacets(abs);
      for (const e of facets.events) b.events.add(e);
      for (const t of facets.tokens) b.tokens.add(t);
    }
  }

  // Drop builders without files.
  const existingIds = new Set(listConstructs(inspection).map((c) => c.id));
  const candidatesAll: IInferredConstruct[] = [];
  for (const b of builders.values()) {
    if (b.files.size === 0) continue;
    if (existingIds.has(b.baseId)) {
      // Skip if construct is already defined locally; still allow drafts via --include-existing.
      continue;
    }
    const relAssets = relatedAssets(inspection, [...b.files]);
    const publicApi = b.publicApi.size > 0 ? [...b.publicApi] : buildPublicApi([...b.files]);
    const c: IInferredConstruct = {
      id: b.baseId,
      type: b.type,
      title: b.title,
      confidence: b.confidence,
      evidence: [...b.evidence].sort(),
      files: [...b.files].sort(),
      publicApi: publicApi.sort(),
      events: [...b.events].slice(0, 6),
      tokens: [...b.tokens].slice(0, 6),
      ...(relAssets.templates.length ? { relatedTemplates: relAssets.templates } : {}),
      ...(relAssets.pipelines.length ? { relatedPipelines: relAssets.pipelines } : {}),
      ...(relAssets.pathConventions.length
        ? { relatedPathConventions: relAssets.pathConventions }
        : {}),
      draft: '',
    };
    c.draft = buildDraft(c);
    candidatesAll.push(c);
  }

  // Sort by confidence desc then file count desc.
  candidatesAll.sort(
    (a, b) =>
      confidenceRank(b.confidence) - confidenceRank(a.confidence) ||
      b.files.length - a.files.length ||
      a.id.localeCompare(b.id),
  );

  let candidates = candidatesAll;
  if (input.type) candidates = candidates.filter((c) => c.type === input.type);
  if (input.minConfidence) {
    const min = confidenceRank(input.minConfidence);
    candidates = candidates.filter((c) => confidenceRank(c.confidence) >= min);
  }
  if (input.limit && input.limit > 0) {
    candidates = candidates.slice(0, input.limit);
  }

  return {
    schema: CONSTRUCT_INFERENCE_SCHEMA,
    generatedAt: new Date().toISOString(),
    projectRoot,
    candidates,
    warnings,
  };
}

export function renderConstructDraftsModule(
  result: IConstructInferenceResult,
): string {
  const lines: string[] = [];
  lines.push("/**");
  lines.push(" * Inferred SharkCraft construct drafts.");
  lines.push(" *");
  lines.push(" * This file is written by `shrk constructs infer --write-drafts`.");
  lines.push(" * Review carefully and copy the bits you want into `sharkcraft/constructs.ts`.");
  lines.push(" * SharkCraft does NOT load this file automatically.");
  lines.push(` * Generated: ${result.generatedAt}`);
  lines.push(" */");
  lines.push("import { defineConstruct } from '@shrkcrft/plugin-api';");
  lines.push('');
  lines.push('export default [');
  for (const c of result.candidates) {
    for (const line of c.draft.split('\n')) lines.push('  ' + line);
  }
  lines.push('];');
  return lines.join('\n') + '\n';
}
