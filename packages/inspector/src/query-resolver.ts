/**
 * Query resolver for fuzzy trace / impact.
 *
 * Resolves a free-form query against multiple registries — files,
 * constructs, knowledge entries, templates, helpers, playbooks,
 * policies, commands, and best-effort symbol matches. The caller decides
 * how to render the result; this module returns the structured match set
 * plus a confidence rating.
 *
 * Schema: sharkcraft.query-resolution/v1
 */
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { HELPERS } from './helper-registry.ts';

export const QUERY_RESOLUTION_SCHEMA = 'sharkcraft.query-resolution/v1';

export enum QueryMatchKind {
  File = 'file',
  Construct = 'construct',
  Knowledge = 'knowledge',
  Template = 'template',
  Helper = 'helper',
  Playbook = 'playbook',
  Policy = 'policy',
  Command = 'command',
  Symbol = 'symbol',
  PluginKey = 'plugin-key',
  EventToken = 'event-token',
  DIToken = 'di-token',
}

export interface IQueryMatch {
  kind: QueryMatchKind;
  id: string;
  label: string;
  score: number;
  reason: string;
}

export interface IQueryResolution {
  schema: typeof QUERY_RESOLUTION_SCHEMA;
  query: string;
  bestMatch?: IQueryMatch;
  alternatives: ReadonlyArray<IQueryMatch>;
  confidence: 'exact' | 'high' | 'medium' | 'low' | 'unknown';
}

export interface IQueryResolveOptions {
  /** Limit number of alternatives returned. */
  limit?: number;
  /** Restrict to a subset of match kinds. */
  kinds?: ReadonlyArray<QueryMatchKind>;
}

function normalize(s: string): string {
  return s.toLowerCase().trim();
}

function scoreText(haystack: string, query: string): number {
  if (!haystack) return 0;
  const h = normalize(haystack);
  const q = normalize(query);
  if (!q) return 0;
  if (h === q) return 100;
  if (h.startsWith(q)) return 80;
  if (h.endsWith(q)) return 70;
  if (h.includes(q)) return 60;
  // token overlap
  const hTokens = new Set(h.split(/[^a-z0-9]+/).filter(Boolean));
  const qTokens = q.split(/[^a-z0-9]+/).filter(Boolean);
  let overlap = 0;
  for (const t of qTokens) if (hTokens.has(t)) overlap += 1;
  if (overlap === 0) return 0;
  return Math.min(50, 10 + overlap * 10);
}

function fileMatches(query: string, projectRoot: string): IQueryMatch | null {
  // If `query` looks like a path AND the file exists, mark exact.
  if (query.includes('/') || query.includes('.')) {
    if (existsSync(nodePath.join(projectRoot, query))) {
      return {
        kind: QueryMatchKind.File,
        id: query,
        label: query,
        score: 100,
        reason: 'file path exists',
      };
    }
  }
  return null;
}

function getList<T extends { id: string }>(
  obj: unknown,
  fnName: 'list',
): readonly T[] {
  const reg = obj as { [k: string]: unknown };
  if (typeof reg?.[fnName] === 'function') {
    try {
      return (reg[fnName] as () => readonly T[])();
    } catch {
      return [];
    }
  }
  return [];
}

function rankList<T extends { id: string; name?: string; title?: string }>(
  list: readonly T[],
  query: string,
  kind: QueryMatchKind,
  reason: (t: T) => string = (t) => `${kind} id matched`,
): IQueryMatch[] {
  const out: IQueryMatch[] = [];
  for (const item of list) {
    const idScore = scoreText(item.id, query);
    const nameScore = Math.max(
      scoreText(item.name ?? '', query),
      scoreText(item.title ?? '', query),
    );
    const score = Math.max(idScore, nameScore * 0.9);
    if (score >= 10) {
      out.push({
        kind,
        id: item.id,
        label: item.name ?? item.title ?? item.id,
        score,
        reason: reason(item),
      });
    }
  }
  return out;
}

function rankConstructs(inspection: ISharkcraftInspection, query: string): IQueryMatch[] {
  const reg = (inspection as { constructRegistry?: unknown }).constructRegistry;
  const list = getList<{ id: string; name?: string; label?: string }>(reg, 'list');
  return rankList(list as readonly { id: string; name?: string; title?: string }[], query, QueryMatchKind.Construct);
}

function rankKnowledge(inspection: ISharkcraftInspection, query: string): IQueryMatch[] {
  return rankList(
    inspection.knowledgeEntries.map((e) => ({ id: e.id, title: e.title })),
    query,
    QueryMatchKind.Knowledge,
  );
}

function rankTemplates(inspection: ISharkcraftInspection, query: string): IQueryMatch[] {
  return rankList(
    inspection.templates.map((t) => ({ id: t.id, name: t.name })),
    query,
    QueryMatchKind.Template,
  );
}

function rankHelpers(query: string): IQueryMatch[] {
  return rankList(HELPERS, query, QueryMatchKind.Helper);
}

function rankPlaybooks(inspection: ISharkcraftInspection, query: string): IQueryMatch[] {
  const reg = (inspection as { playbookRegistry?: unknown }).playbookRegistry;
  const list = getList<{ id: string; title?: string; name?: string }>(reg, 'list');
  return rankList(list as readonly { id: string; name?: string; title?: string }[], query, QueryMatchKind.Playbook);
}

function rankPolicies(inspection: ISharkcraftInspection, query: string): IQueryMatch[] {
  const checks = (inspection as { policyChecks?: readonly { id: string; title?: string }[] }).policyChecks ?? [];
  return rankList(checks, query, QueryMatchKind.Policy);
}

function rankCommands(inspection: ISharkcraftInspection, query: string): IQueryMatch[] {
  const cat = (inspection as { commandCatalog?: readonly { id: string; name?: string; description?: string }[] }).commandCatalog ?? [];
  return rankList(cat, query, QueryMatchKind.Command);
}

function pickConfidence(top?: IQueryMatch): IQueryResolution['confidence'] {
  if (!top) return 'unknown';
  if (top.score >= 95) return 'exact';
  if (top.score >= 70) return 'high';
  if (top.score >= 40) return 'medium';
  return 'low';
}

export function resolveQuery(
  inspection: ISharkcraftInspection,
  query: string,
  options: IQueryResolveOptions = {},
): IQueryResolution {
  const matches: IQueryMatch[] = [];
  // 1) file path → exact match wins.
  const file = fileMatches(query, inspection.projectRoot);
  if (file) matches.push(file);

  matches.push(
    ...rankConstructs(inspection, query),
    ...rankKnowledge(inspection, query),
    ...rankTemplates(inspection, query),
    ...rankHelpers(query),
    ...rankPlaybooks(inspection, query),
    ...rankPolicies(inspection, query),
    ...rankCommands(inspection, query),
  );

  const filtered = options.kinds && options.kinds.length > 0
    ? matches.filter((m) => options.kinds!.includes(m.kind))
    : matches;

  filtered.sort((a, b) => b.score - a.score);
  const limit = options.limit ?? 10;
  const top = filtered[0];
  return {
    schema: QUERY_RESOLUTION_SCHEMA,
    query,
    ...(top ? { bestMatch: top } : {}),
    alternatives: filtered.slice(1, limit + 1),
    confidence: pickConfidence(top),
  };
}
