import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { listFeatureBundles } from './feature-bundle.ts';
import { listDevSessionsDetailed } from './dev-session.ts';
import { listConstructs, type IConstruct, type IConstructFacet } from './construct-registry.ts';
import { listPlaybooks, type IPlaybook } from './playbook-registry.ts';
import {
  listSearchTuning,
  tuningBoostFor,
  type ISearchTuningEntry,
} from './search-tuning-registry.ts';

export const SEARCH_INDEX_SCHEMA = 'sharkcraft.search-index/v1';

export enum SearchKind {
  Knowledge = 'knowledge',
  Rule = 'rule',
  Path = 'path',
  Template = 'template',
  Pipeline = 'pipeline',
  Preset = 'preset',
  Pack = 'pack',
  Boundary = 'boundary',
  Policy = 'policy',
  Doc = 'doc',
  Session = 'session',
  Bundle = 'bundle',
  Construct = 'construct',
  ConstructFacet = 'construct-facet',
  Playbook = 'playbook',
  ScaffoldPattern = 'scaffold-pattern',
  Command = 'command',
}

export enum SearchSource {
  Local = 'local',
  Pack = 'pack',
  Session = 'session',
  Bundle = 'bundle',
  Builtin = 'builtin',
  Doc = 'doc',
}

export interface ISearchDocument {
  id: string;
  kind: SearchKind;
  title: string;
  content?: string;
  tags?: readonly string[];
  appliesWhen?: readonly string[];
  source: SearchSource;
  sourcePackage?: string;
  sourceFile?: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  fields?: Record<string, string | readonly string[]>;
  relatedIds?: readonly string[];
}

export interface ISearchOptions {
  query: string;
  /** Filter to one or more `kind`s. Empty ⇒ all. */
  kinds?: readonly SearchKind[];
  /** Filter to one or more sources. */
  sources?: readonly SearchSource[];
  /** Limit the total results. Default: 30. */
  limit?: number;
  /** Include reasons / why-matched for each hit. */
  explain?: boolean;
  /** Tuning entries to bias scoring. Defaults to the inspection's loaded set. */
  tuning?: readonly ISearchTuningEntry[];
}

export interface ISearchHit {
  document: ISearchDocument;
  score: number;
  matchedFields: readonly string[];
  reasons: readonly string[];
  snippet?: string;
}

export interface ISearchResult {
  query: string;
  total: number;
  truncated: boolean;
  hits: readonly ISearchHit[];
  grouped: ReadonlyMap<SearchKind, readonly ISearchHit[]>;
}

const KIND_WEIGHTS: Partial<Record<SearchKind, number>> = {
  [SearchKind.Rule]: 5,
  [SearchKind.Knowledge]: 4,
  [SearchKind.Template]: 4,
  [SearchKind.Pipeline]: 4,
  [SearchKind.Construct]: 4,
  [SearchKind.Playbook]: 4,
  [SearchKind.Policy]: 3,
  [SearchKind.Boundary]: 3,
  [SearchKind.Path]: 3,
  [SearchKind.Pack]: 3,
  [SearchKind.Preset]: 3,
  [SearchKind.ScaffoldPattern]: 2,
  [SearchKind.Session]: 2,
  [SearchKind.Bundle]: 2,
  [SearchKind.ConstructFacet]: 2,
  [SearchKind.Doc]: 1,
  [SearchKind.Command]: 1,
};

const PRIORITY_WEIGHTS: Record<string, number> = {
  critical: 8,
  high: 5,
  medium: 2,
  low: 1,
};

function safeContent(value: string | undefined, max = 400): string | undefined {
  if (!value) return undefined;
  return value.length > max ? value.slice(0, max) + '…' : value;
}

function toLower(s: string): string {
  return s.toLowerCase();
}

function makeSnippet(text: string | undefined, terms: readonly string[]): string | undefined {
  if (!text) return undefined;
  const haystack = text;
  const lower = haystack.toLowerCase();
  for (const term of terms) {
    const idx = lower.indexOf(term.toLowerCase());
    if (idx >= 0) {
      const start = Math.max(0, idx - 40);
      const end = Math.min(haystack.length, idx + term.length + 80);
      const snip = haystack.slice(start, end).replace(/\s+/g, ' ').trim();
      return (start > 0 ? '…' : '') + snip + (end < haystack.length ? '…' : '');
    }
  }
  return undefined;
}

function loadDocFiles(projectRoot: string): ISearchDocument[] {
  const docsDir = nodePath.join(projectRoot, 'docs');
  if (!existsSync(docsDir)) return [];
  const out: ISearchDocument[] = [];
  try {
    for (const f of readdirSync(docsDir)) {
      if (!f.endsWith('.md')) continue;
      const full = nodePath.join(docsDir, f);
      try {
        if (!statSync(full).isFile()) continue;
      } catch {
        continue;
      }
      let content = '';
      try {
        content = readFileSync(full, 'utf8');
      } catch {
        /* ignore */
      }
      const titleMatch = /^#\s+(.+)/m.exec(content);
      const title = titleMatch?.[1]?.trim() ?? f.replace(/\.md$/, '');
      out.push({
        id: `doc:${f}`,
        kind: SearchKind.Doc,
        title,
        content: safeContent(content, 1200),
        source: SearchSource.Doc,
        sourceFile: `docs/${f}`,
      });
    }
  } catch {
    /* ignore */
  }
  return out;
}

export function buildSearchIndex(inspection: ISharkcraftInspection): ISearchDocument[] {
  const docs: ISearchDocument[] = [];
  for (const k of inspection.knowledgeEntries) {
    const src = inspection.entrySources.get(k.id);
    docs.push({
      id: `knowledge:${k.id}`,
      kind: SearchKind.Knowledge,
      title: k.title ?? k.id,
      content: safeContent(
        [k.summary ?? '', k.content ?? ''].filter(Boolean).join('\n\n'),
        1200,
      ),
      ...(k.tags ? { tags: k.tags } : {}),
      ...(k.appliesWhen ? { appliesWhen: k.appliesWhen as readonly string[] } : {}),
      ...(k.priority ? { priority: k.priority as 'critical' | 'high' | 'medium' | 'low' } : {}),
      source: src?.type === 'pack' ? SearchSource.Pack : SearchSource.Local,
      ...(src?.packageName ? { sourcePackage: src.packageName } : {}),
      ...(src?.file ? { sourceFile: src.file } : {}),
    });
  }
  for (const r of inspection.ruleService.list()) {
    docs.push({
      id: `rule:${r.id}`,
      kind: SearchKind.Rule,
      title: r.title ?? r.id,
      content: safeContent(r.summary ?? r.content ?? '', 800),
      ...((r as { tags?: readonly string[] }).tags
        ? { tags: (r as { tags?: readonly string[] }).tags ?? [] }
        : {}),
      ...((r as { appliesWhen?: readonly string[] }).appliesWhen
        ? { appliesWhen: (r as { appliesWhen?: readonly string[] }).appliesWhen ?? [] }
        : {}),
      ...((r as { priority?: 'critical' | 'high' | 'medium' | 'low' }).priority
        ? { priority: (r as { priority?: 'critical' | 'high' | 'medium' | 'low' }).priority }
        : {}),
      source: SearchSource.Local,
    });
  }
  for (const p of inspection.pathService.list()) {
    const meta = (p.metadata ?? {}) as { path?: string; description?: string };
    docs.push({
      id: `path:${p.id}`,
      kind: SearchKind.Path,
      title: p.title ?? p.id,
      content: safeContent(meta.description ?? p.summary ?? p.content ?? '', 400),
      ...((p as { tags?: readonly string[] }).tags
        ? { tags: (p as { tags?: readonly string[] }).tags ?? [] }
        : {}),
      source: SearchSource.Local,
      fields: {
        path: meta.path ?? '',
      },
    });
  }
  for (const t of inspection.templateRegistry.list()) {
    const src = inspection.templateSources.get(t.id);
    docs.push({
      id: `template:${t.id}`,
      kind: SearchKind.Template,
      title: t.name ?? t.id,
      content: safeContent((t as { description?: string }).description ?? '', 800),
      ...((t as { tags?: readonly string[] }).tags
        ? { tags: (t as { tags?: readonly string[] }).tags ?? [] }
        : {}),
      source: src?.type === 'pack' ? SearchSource.Pack : SearchSource.Local,
      ...(src?.packageName ? { sourcePackage: src.packageName } : {}),
      ...(src?.file ? { sourceFile: src.file } : {}),
    });
  }
  for (const p of inspection.pipelineRegistry.list()) {
    const src = inspection.pipelineSources.get(p.id);
    docs.push({
      id: `pipeline:${p.id}`,
      kind: SearchKind.Pipeline,
      title: p.title ?? p.id,
      content: safeContent((p as { description?: string }).description ?? '', 800),
      ...((p as { tags?: readonly string[] }).tags
        ? { tags: (p as { tags?: readonly string[] }).tags ?? [] }
        : {}),
      source: src?.type === 'pack' ? SearchSource.Pack : SearchSource.Local,
      ...(src?.packageName ? { sourcePackage: src.packageName } : {}),
    });
  }
  try {
    const presets = inspection.presetRegistry.list() as unknown as readonly {
      id: string;
      name?: string;
      description?: string;
    }[];
    for (const p of presets) {
      const src = inspection.presetSources?.get(p.id);
      docs.push({
        id: `preset:${p.id}`,
        kind: SearchKind.Preset,
        title: p.name ?? p.id,
        content: safeContent(p.description ?? '', 400),
        source: src?.type === 'pack' ? SearchSource.Pack : SearchSource.Builtin,
        ...(src?.packageName ? { sourcePackage: src.packageName } : {}),
      });
    }
  } catch {
    /* ignore */
  }
  for (const pack of inspection.packs.validPacks ?? []) {
    docs.push({
      id: `pack:${pack.packageName}`,
      kind: SearchKind.Pack,
      title: pack.packageName,
      content: safeContent(pack.manifest?.info?.description ?? '', 400),
      source: SearchSource.Pack,
      sourcePackage: pack.packageName,
      fields: {
        version: pack.packageVersion,
      },
    });
  }
  for (const r of inspection.boundaryRegistry.list()) {
    const rb = r as {
      title?: string;
      description?: string;
      message?: string;
      tags?: readonly string[];
      from?: readonly string[];
      forbiddenImports?: readonly string[];
      allowedImports?: readonly string[];
    };
    docs.push({
      id: `boundary:${r.id}`,
      kind: SearchKind.Boundary,
      title: rb.title ?? r.id,
      content: safeContent(rb.description ?? rb.message ?? '', 400),
      ...(rb.tags ? { tags: rb.tags } : {}),
      source: SearchSource.Local,
      fields: {
        from: (rb.from ?? []).join(', '),
        forbidden: (rb.forbiddenImports ?? []).join(', '),
        allowed: (rb.allowedImports ?? []).join(', '),
      },
    });
  }
  // Policies (registered checks).
  try {
    const cfg = inspection.config as { policyCheckFiles?: readonly string[] } | null;
    void cfg;
  } catch {
    /* ignore */
  }
  // Bundles, sessions.
  try {
    const bundles = listFeatureBundles(inspection.projectRoot);
    for (const b of bundles) {
      docs.push({
        id: `bundle:${b.id}`,
        kind: SearchKind.Bundle,
        title: b.task ?? b.id,
        content: safeContent(b.task ?? '', 400),
        source: SearchSource.Bundle,
        fields: { status: b.status, risk: b.riskLevel },
      });
    }
  } catch {
    /* ignore */
  }
  try {
    const sessions = listDevSessionsDetailed(inspection.projectRoot);
    for (const s of sessions) {
      docs.push({
        id: `session:${s.id}`,
        kind: SearchKind.Session,
        title: s.task || s.id,
        source: SearchSource.Session,
        fields: { phase: s.phase ?? '', nextAction: s.nextAction ?? '' },
      });
    }
  } catch {
    /* ignore */
  }
  // Constructs / facets / playbooks (loaded lazily via registries).
  try {
    const constructs = listConstructs(inspection);
    for (const c of constructs) {
      docs.push({
        id: `construct:${c.id}`,
        kind: SearchKind.Construct,
        title: c.title ?? c.id,
        content: safeContent(c.description ?? '', 600),
        ...(c.tags ? { tags: c.tags } : {}),
        source: c.source === 'pack' ? SearchSource.Pack : SearchSource.Local,
        ...(c.packageName ? { sourcePackage: c.packageName } : {}),
        fields: { type: c.type },
      });
      for (const f of facetsFor(c)) {
        docs.push({
          id: `facet:${c.id}:${f.id}`,
          kind: SearchKind.ConstructFacet,
          title: `${c.id} / ${f.kind}: ${f.value}`,
          content: safeContent(f.description ?? '', 200),
          source: c.source === 'pack' ? SearchSource.Pack : SearchSource.Local,
          fields: { construct: c.id, kind: f.kind, value: f.value },
        });
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const playbooks = listPlaybooks(inspection);
    for (const p of playbooks) {
      docs.push({
        id: `playbook:${p.id}`,
        kind: SearchKind.Playbook,
        title: p.title ?? p.id,
        content: safeContent(p.description ?? '', 600),
        ...(p.tags ? { tags: p.tags } : {}),
        source: p.source === 'pack' ? SearchSource.Pack : SearchSource.Local,
        ...(p.packageName ? { sourcePackage: p.packageName } : {}),
      });
    }
  } catch {
    /* ignore */
  }
  // Docs.
  docs.push(...loadDocFiles(inspection.projectRoot));
  return docs;
}

function facetsFor(c: IConstruct): readonly IConstructFacet[] {
  const explicit = c.facets ?? {};
  const out: IConstructFacet[] = [];
  for (const [kind, list] of Object.entries(explicit)) {
    for (const value of list as readonly { id: string; value: string; description?: string }[]) {
      out.push({
        id: value.id,
        constructId: c.id,
        kind,
        value: value.value,
        ...(value.description ? { description: value.description } : {}),
      });
    }
  }
  for (const e of c.events ?? []) {
    out.push({ id: `event:${e}`, constructId: c.id, kind: 'event', value: e });
  }
  for (const t of c.tokens ?? []) {
    out.push({ id: `token:${t}`, constructId: c.id, kind: 'token', value: t });
  }
  for (const a of c.publicApi ?? []) {
    out.push({ id: `api:${a}`, constructId: c.id, kind: 'api', value: a });
  }
  return out;
}

function tokenize(input: string): string[] {
  return input
    .split(/[\s,\.;:\/]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
}

function scoreDocument(
  doc: ISearchDocument,
  query: string,
  tokens: readonly string[],
  options: ISearchOptions,
): { score: number; matchedFields: string[]; reasons: string[] } {
  const lowerQuery = query.toLowerCase();
  const matchedFields = new Set<string>();
  const reasons: string[] = [];
  let score = 0;

  const lowerId = doc.id.toLowerCase();
  const lowerTitle = doc.title.toLowerCase();
  if (lowerId === lowerQuery || lowerId.endsWith(':' + lowerQuery)) {
    score += 100;
    matchedFields.add('id');
    reasons.push('exact id match');
  } else if (lowerId.includes(lowerQuery)) {
    score += 20;
    matchedFields.add('id');
    reasons.push('id contains query');
  }
  if (lowerTitle === lowerQuery) {
    score += 40;
    matchedFields.add('title');
    reasons.push('exact title match');
  } else if (lowerTitle.includes(lowerQuery)) {
    score += 12;
    matchedFields.add('title');
    reasons.push('title contains query');
  }
  for (const tag of doc.tags ?? []) {
    if (tokens.some((t) => tag.toLowerCase() === t)) {
      score += 6;
      matchedFields.add('tags');
      reasons.push(`tag ${tag}`);
      break;
    }
  }
  for (const applies of doc.appliesWhen ?? []) {
    if (tokens.some((t) => applies.toLowerCase().includes(t))) {
      score += 4;
      matchedFields.add('appliesWhen');
      reasons.push(`appliesWhen ${applies}`);
      break;
    }
  }
  for (const tok of tokens) {
    if (doc.content && doc.content.toLowerCase().includes(tok)) {
      score += 2;
      matchedFields.add('content');
      reasons.push(`content has "${tok}"`);
    }
    if (doc.fields) {
      for (const [k, v] of Object.entries(doc.fields)) {
        const str = Array.isArray(v) ? v.join(' ') : String(v);
        if (str.toLowerCase().includes(tok)) {
          score += 1;
          matchedFields.add(`field:${k}`);
        }
      }
    }
    for (const rel of doc.relatedIds ?? []) {
      if (rel.toLowerCase().includes(tok)) {
        score += 2;
        matchedFields.add('relatedIds');
      }
    }
  }
  const kindWeight = KIND_WEIGHTS[doc.kind] ?? 1;
  score *= 1 + kindWeight / 10;
  if (doc.priority) {
    score += PRIORITY_WEIGHTS[doc.priority] ?? 0;
    matchedFields.add(`priority:${doc.priority}`);
  }
  if (options.kinds && !options.kinds.includes(doc.kind)) score = 0;
  if (options.sources && !options.sources.includes(doc.source)) score = 0;
  return { score, matchedFields: [...matchedFields], reasons };
}

export function searchIndex(
  index: readonly ISearchDocument[],
  options: ISearchOptions,
  inspection?: ISharkcraftInspection,
): ISearchResult {
  const query = options.query.trim();
  if (!query) {
    return {
      query: '',
      total: 0,
      truncated: false,
      hits: [],
      grouped: new Map(),
    };
  }
  const tokens = tokenize(query.toLowerCase());
  const tuning =
    options.tuning ?? (inspection ? listSearchTuning(inspection) : []);
  const hits: ISearchHit[] = [];
  for (const doc of index) {
    const { score, matchedFields, reasons } = scoreDocument(doc, query, tokens, options);
    if (score <= 0) continue;
    let finalScore = score;
    let finalReasons = options.explain ? [...reasons] : [];
    if (tuning.length > 0) {
      const boost = tuningBoostFor(
        { id: doc.id, kind: doc.kind, ...(doc.tags ? { tags: doc.tags } : {}), source: doc.source },
        tokens,
        tuning,
      );
      if (boost.delta !== 0) {
        finalScore += boost.delta;
        if (options.explain) finalReasons.push(...boost.reasons);
        matchedFields.push('tuning');
      }
    }
    const hit: ISearchHit = {
      document: doc,
      score: Math.round(finalScore * 100) / 100,
      matchedFields,
      reasons: finalReasons,
    };
    const snippet = makeSnippet(doc.content, tokens);
    if (snippet) hit.snippet = snippet;
    hits.push(hit);
  }
  hits.sort((a, b) => b.score - a.score || a.document.id.localeCompare(b.document.id));
  const limit = options.limit ?? 30;
  const truncated = hits.length > limit;
  const top = hits.slice(0, limit);
  const grouped = new Map<SearchKind, ISearchHit[]>();
  for (const h of top) {
    const arr = grouped.get(h.document.kind) ?? [];
    arr.push(h);
    grouped.set(h.document.kind, arr);
  }
  return {
    query,
    total: hits.length,
    truncated,
    hits: top,
    grouped,
  };
}

export function renderSearchText(result: ISearchResult): string {
  const lines: string[] = [];
  lines.push(`Search: "${result.query}" — ${result.total} match(es)${result.truncated ? ' (truncated)' : ''}`);
  for (const [kind, hits] of result.grouped) {
    lines.push('');
    lines.push(`# ${kind} (${hits.length})`);
    for (const h of hits) {
      lines.push(`  ${h.score.toString().padStart(6)}  ${h.document.id}  — ${h.document.title}`);
      if (h.snippet) lines.push(`         ${h.snippet}`);
      if (h.reasons.length > 0) {
        lines.push(`         (${h.reasons.slice(0, 3).join(', ')})`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

function toLowerCase(s: string): string {
  return s.toLowerCase();
}
void toLower;
void toLowerCase;
