/**
 * Dashboard data builders for the Knowledge explorer page. Pure, deterministic,
 * JSON-serializable — no network, no LLM (the LLM-backed "ask" lives in the CLI
 * dashboard layer so the inspector stays AI-free). The dashboard API server
 * wraps these with @shrkcrft/dashboard-api envelopes.
 */
import { relative } from 'node:path';
import type {
  IDashboardKnowledgeActionHints,
  IDashboardKnowledgeDetail,
  IDashboardKnowledgeEntryResponse,
  IDashboardKnowledgeExample,
  IDashboardKnowledgeFacet,
  IDashboardKnowledgeGraphResponse,
  IDashboardKnowledgeInsights,
  IDashboardKnowledgeListResponse,
  IDashboardKnowledgeNeighbor,
  IDashboardKnowledgeSimilar,
  IDashboardKnowledgeSimilarResponse,
  IDashboardKnowledgeSummary,
  IDashboardCommandHint,
} from '@shrkcrft/dashboard-api';
import {
  hasActionHints,
  priorityWeight,
  searchKnowledge,
  type IActionHints,
  type IKnowledgeEntry,
} from '@shrkcrft/knowledge';
import type { ISharkcraftInspection } from '../sharkcraft-inspector.ts';
import { buildKnowledgeGraph, getGraphNode } from '../knowledge-graph.ts';

/** GraphSvg colours by kind — map a knowledge entry's type to one of them. */
function nodeKindForType(type: string): string {
  if (type === 'rule') return 'rule';
  if (type === 'path') return 'path';
  if (type === 'template') return 'template';
  return 'knowledge';
}

function sourceLabel(entry: IKnowledgeEntry, projectRoot: string): string {
  const origin = entry.source?.origin;
  if (!origin) return entry.source?.loader ?? 'local';
  if (origin.startsWith('http')) return origin;
  const rel = relative(projectRoot, origin);
  return rel && !rel.startsWith('..') ? rel : origin;
}

function commandHint(command: string, purpose: string): IDashboardCommandHint {
  return { command, purpose, safety: 'read-only' };
}

function summaryOf(entry: IKnowledgeEntry, projectRoot: string): IDashboardKnowledgeSummary {
  const summary: IDashboardKnowledgeSummary = {
    id: entry.id,
    title: entry.title,
    type: String(entry.type),
    priority: String(entry.priority),
    scope: [...entry.scope],
    tags: [...entry.tags],
    relatedCount: (entry.related?.length ?? 0),
    hasActionHints: hasActionHints(entry),
    source: sourceLabel(entry, projectRoot),
  };
  return entry.summary ? { ...summary, summary: entry.summary } : summary;
}

function mapActionHints(h: IActionHints): IDashboardKnowledgeActionHints {
  return {
    commands: (h.commands ?? []).map((c) => c.command),
    mcpTools: (h.mcpTools ?? []).map((t) => t.tool),
    preferredFlow: [...(h.preferredFlow ?? [])],
    forbiddenActions: [...(h.forbiddenActions ?? [])],
    verificationCommands: [...(h.verificationCommands ?? [])],
    relatedTemplates: [...(h.relatedTemplates ?? [])],
    relatedPathConventions: [...(h.relatedPathConventions ?? [])],
    relatedKnowledge: [...(h.relatedKnowledge ?? [])],
    ...(h.writePolicy ? { writePolicy: String(h.writePolicy) } : {}),
  };
}

function detailOf(entry: IKnowledgeEntry, projectRoot: string): IDashboardKnowledgeDetail {
  const examples: IDashboardKnowledgeExample[] = (entry.examples ?? []).map((ex) => ({
    ...(ex.title ? { title: ex.title } : {}),
    ...(ex.description ? { description: ex.description } : {}),
    ...(ex.language ? { language: ex.language } : {}),
    ...(ex.code ? { code: ex.code } : {}),
  }));
  const detail: IDashboardKnowledgeDetail = {
    id: entry.id,
    title: entry.title,
    type: String(entry.type),
    priority: String(entry.priority),
    scope: [...entry.scope],
    tags: [...entry.tags],
    appliesWhen: [...entry.appliesWhen],
    content: entry.content,
    related: [...(entry.related ?? [])],
    source: sourceLabel(entry, projectRoot),
    examples,
  };
  const withSummary = entry.summary ? { ...detail, summary: entry.summary } : detail;
  return entry.actionHints
    ? { ...withSummary, actionHints: mapActionHints(entry.actionHints) }
    : withSummary;
}

function facetCounts(
  entries: readonly IKnowledgeEntry[],
  pick: (e: IKnowledgeEntry) => readonly string[],
): IDashboardKnowledgeFacet[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    for (const v of pick(e)) {
      if (!v) continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/** Sort: highest priority first, then alphabetical by id. */
function byPriorityThenId(a: IKnowledgeEntry, b: IKnowledgeEntry): number {
  const w = priorityWeight(b.priority as never) - priorityWeight(a.priority as never);
  return w !== 0 ? w : a.id.localeCompare(b.id);
}

function roundScore(n: number): number {
  return Math.round(n * 100) / 100;
}

function computeInsights(entries: readonly IKnowledgeEntry[]): IDashboardKnowledgeInsights {
  const byPriority = { critical: 0, high: 0, medium: 0, low: 0 };
  let withoutActionHints = 0;
  let withoutSummary = 0;
  let orphans = 0;
  for (const e of entries) {
    const p = String(e.priority);
    if (p === 'critical' || p === 'high' || p === 'medium' || p === 'low') byPriority[p] += 1;
    if (!hasActionHints(e)) withoutActionHints += 1;
    if (!e.summary) withoutSummary += 1;
    if (!(e.related?.length) && !(e.actionHints?.relatedKnowledge?.length)) orphans += 1;
  }
  return { byPriority, withoutActionHints, withoutSummary, orphans };
}

export function buildDashboardKnowledgeList(
  inspection: ISharkcraftInspection,
): IDashboardKnowledgeListResponse {
  const entries = inspection.knowledgeEntries;
  const sorted = [...entries].sort(byPriorityThenId);
  return {
    available: entries.length > 0,
    total: entries.length,
    entries: sorted.map((e) => summaryOf(e, inspection.projectRoot)),
    facets: {
      types: facetCounts(entries, (e) => [String(e.type)]),
      scopes: facetCounts(entries, (e) => e.scope),
      tags: facetCounts(entries, (e) => e.tags),
      priorities: facetCounts(entries, (e) => [String(e.priority)]),
    },
    insights: computeInsights(entries),
    commandHints: [
      commandHint('shrk knowledge list', 'List every knowledge entry'),
      commandHint('shrk knowledge search "<query>"', 'Rank entries by relevance to a query'),
      commandHint('shrk knowledge get <id>', 'Read a single entry in the terminal'),
    ],
  };
}

export function buildDashboardKnowledgeEntry(
  inspection: ISharkcraftInspection,
  id: string,
): IDashboardKnowledgeEntryResponse {
  const entries = inspection.knowledgeEntries;
  const entry = entries.find((e) => e.id === id);
  if (!entry) {
    return { found: false, inbound: [], outbound: [], related: [], commandHints: [] };
  }
  const graph = buildKnowledgeGraph(inspection);
  const located = getGraphNode(graph, { id });
  // Graph edge endpoints are namespaced node keys (`kind:id`), so resolve the
  // raw id + kind through byId rather than echoing the key.
  const toNeighbor = (
    endpointKey: string,
    relation: string,
    why: string,
  ): IDashboardKnowledgeNeighbor => {
    const node = graph.byId.get(endpointKey);
    // Edges only ever target nodes present in the graph, but if a lookup ever
    // misses, strip the `kind:` prefix so a raw id (not the namespaced key)
    // still reaches the client — `id` must be a clickable entry id.
    const colon = endpointKey.indexOf(':');
    const fallbackId = colon >= 0 ? endpointKey.slice(colon + 1) : endpointKey;
    return {
      id: node?.id ?? fallbackId,
      kind: node?.kind ?? 'knowledge',
      relation,
      why,
    };
  };
  const inbound = (located?.incoming ?? []).map((e) => toNeighbor(e.from, e.relation, e.why));
  const outbound = (located?.outgoing ?? []).map((e) => toNeighbor(e.to, e.relation, e.why));

  const relatedIds = [
    ...new Set([...(entry.related ?? []), ...(entry.actionHints?.relatedKnowledge ?? [])]),
  ];
  const related = relatedIds
    .map((rid) => entries.find((e) => e.id === rid))
    .filter((e): e is IKnowledgeEntry => Boolean(e))
    .map((e) => summaryOf(e, inspection.projectRoot));

  return {
    found: true,
    entry: detailOf(entry, inspection.projectRoot),
    inbound,
    outbound,
    related,
    commandHints: [
      commandHint(`shrk knowledge get ${entry.id}`, 'Read this entry in the terminal'),
      commandHint(`shrk graph node ${entry.id}`, 'Inspect this node and its edges'),
    ],
  };
}

/** Cap the rendered graph — the ring layout stays legible up to ~120 nodes. */
const MAX_GRAPH_NODES = 120;

export function buildDashboardKnowledgeGraph(
  inspection: ISharkcraftInspection,
): IDashboardKnowledgeGraphResponse {
  const all = [...inspection.knowledgeEntries].sort(byPriorityThenId);
  const truncated = all.length > MAX_GRAPH_NODES;
  const entries = all.slice(0, MAX_GRAPH_NODES);
  const ids = new Set(entries.map((e) => e.id));

  const nodes = entries.map((e) => ({
    id: e.id,
    kind: nodeKindForType(String(e.type)),
    label: e.title,
  }));

  const edges: { from: string; to: string; kind: string }[] = [];
  const seen = new Set<string>();
  const addEdge = (from: string, to: string, kind: string): void => {
    if (from === to || !ids.has(from) || !ids.has(to)) return;
    const key = from < to ? `${from}|${to}|${kind}` : `${to}|${from}|${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, kind });
  };

  // Semantic edges: explicit cross-references.
  for (const e of entries) {
    for (const t of [...(e.related ?? []), ...(e.actionHints?.relatedKnowledge ?? [])]) {
      addEdge(e.id, t, 'related');
    }
  }

  // Scope clusters: chain entries that share a scope so the graph forms loose,
  // legible neighbourhoods instead of an O(n²) hairball.
  const byScope = new Map<string, string[]>();
  for (const e of entries) {
    for (const s of e.scope) {
      const list = byScope.get(s) ?? [];
      list.push(e.id);
      byScope.set(s, list);
    }
  }
  for (const group of byScope.values()) {
    for (let i = 1; i < group.length; i += 1) {
      addEdge(group[i - 1]!, group[i]!, 'scope');
    }
  }

  return { available: entries.length > 0, nodes, edges, truncated };
}

/** Relevance-ranked "more like this" for one entry (lexical, deterministic). */
export function buildDashboardKnowledgeSimilar(
  inspection: ISharkcraftInspection,
  id: string,
): IDashboardKnowledgeSimilarResponse {
  const entries = inspection.knowledgeEntries;
  const entry = entries.find((e) => e.id === id);
  if (!entry) return { id, available: false, similar: [] };
  // Use the entry's own signature (title + tags + scope) as the query. With no
  // signature there's nothing to match on — return empty rather than letting
  // searchKnowledge fall back to a priority-only ranking of everything.
  const query = [entry.title, ...entry.tags, ...entry.scope].join(' ').trim();
  if (!query) return { id, available: false, similar: [] };
  const results = searchKnowledge(entries, { query, limit: 8 });
  const similar: IDashboardKnowledgeSimilar[] = results
    .filter((r) => r.entry.id !== id)
    .slice(0, 6)
    .map((r) => ({
      id: r.entry.id,
      title: r.entry.title,
      type: String(r.entry.type),
      score: roundScore(r.score),
      reasons: [...new Set(r.reasons.map((x) => x.field))].slice(0, 4),
    }));
  return { id, available: similar.length > 0, similar };
}
