import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export type GraphNodeKind =
  | 'knowledge'
  | 'rule'
  | 'path'
  | 'template'
  | 'pipeline'
  | 'preset'
  | 'pack'
  | 'boundary'
  | 'doc';

export interface IGraphNode {
  id: string;
  kind: GraphNodeKind;
  title: string;
  /** Optional one-line summary. */
  summary?: string;
  /** Source: builtin | local | pack:<name> */
  source: string;
}

export type GraphEdgeRelation =
  | 'related-template'
  | 'related-path'
  | 'related-rule'
  | 'preset-includes'
  | 'preset-references'
  | 'pipeline-step-references'
  | 'pack-contributes'
  | 'boundary-related-rule'
  | 'boundary-related-path'
  | 'composes';

export interface IGraphEdge {
  from: string; // node id (kind:id)
  to: string; // node id (kind:id)
  relation: GraphEdgeRelation;
  /** Free-form note explaining why the edge exists. */
  why: string;
}

export interface IKnowledgeGraph {
  nodes: IGraphNode[];
  edges: IGraphEdge[];
  /** Convenience: lookup by composite id (kind:id). */
  byId: ReadonlyMap<string, IGraphNode>;
}

function nodeKey(kind: GraphNodeKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * Build the full SharkCraft knowledge graph for the current inspection.
 * Pure — no I/O beyond what the inspection already cached.
 */
export function buildKnowledgeGraph(inspection: ISharkcraftInspection): IKnowledgeGraph {
  const nodes: IGraphNode[] = [];
  const edges: IGraphEdge[] = [];
  const byId = new Map<string, IGraphNode>();

  function addNode(n: IGraphNode): void {
    const key = nodeKey(n.kind, n.id);
    if (byId.has(key)) return;
    byId.set(key, n);
    nodes.push(n);
  }
  function addEdge(
    from: { kind: GraphNodeKind; id: string },
    to: { kind: GraphNodeKind; id: string },
    relation: GraphEdgeRelation,
    why: string,
  ): void {
    const fromKey = nodeKey(from.kind, from.id);
    const toKey = nodeKey(to.kind, to.id);
    if (!byId.has(toKey)) return; // don't add edges to nodes we didn't see
    if (!byId.has(fromKey)) return;
    edges.push({ from: fromKey, to: toKey, relation, why });
  }
  function sourceOf(
    map: ReadonlyMap<string, { type: string; packageName?: string }>,
    id: string,
  ): string {
    const s = map.get(id);
    if (!s) return 'builtin';
    if (s.type === 'pack') return `pack:${s.packageName ?? '<unknown>'}`;
    return 'local';
  }

  // ── Nodes ─────────────────────────────────────────────────────────────
  for (const e of inspection.knowledgeEntries) {
    const kind: GraphNodeKind =
      String(e.type) === 'rule' ? 'rule' : String(e.type) === 'path' ? 'path' : 'knowledge';
    addNode({
      id: e.id,
      kind,
      title: e.title,
      summary: e.content.slice(0, 120),
      source: sourceOf(inspection.entrySources, e.id),
    });
  }
  for (const t of inspection.templates) {
    addNode({
      id: t.id,
      kind: 'template',
      title: t.name,
      summary: t.description,
      source: sourceOf(inspection.templateSources, t.id),
    });
  }
  for (const p of inspection.pipelines) {
    addNode({
      id: p.id,
      kind: 'pipeline',
      title: p.title,
      summary: p.description,
      source: sourceOf(inspection.pipelineSources, p.id),
    });
  }
  for (const preset of inspection.presetRegistry.list()) {
    addNode({
      id: preset.id,
      kind: 'preset',
      title: preset.title,
      summary: preset.description,
      source: sourceOf(inspection.presetSources, preset.id),
    });
  }
  for (const r of inspection.boundaryRegistry.list()) {
    addNode({
      id: r.id,
      kind: 'boundary',
      title: r.title,
      summary: r.description,
      source: sourceOf(inspection.boundarySources, r.id),
    });
  }
  for (const pack of inspection.packs.discoveredPacks) {
    addNode({
      id: pack.packageName,
      kind: 'pack',
      title: `${pack.packageName}@${pack.packageVersion}`,
      summary: pack.manifest?.info.description,
      source: 'pack',
    });
  }

  // ── Edges ─────────────────────────────────────────────────────────────
  // Action hints → related templates / paths / rules.
  for (const e of inspection.knowledgeEntries) {
    const ah = e.actionHints;
    if (!ah) continue;
    const fromKind: GraphNodeKind =
      String(e.type) === 'rule' ? 'rule' : String(e.type) === 'path' ? 'path' : 'knowledge';
    for (const id of ah.relatedTemplates ?? []) {
      addEdge(
        { kind: fromKind, id: e.id },
        { kind: 'template', id },
        'related-template',
        'actionHints.relatedTemplates',
      );
    }
    for (const id of ah.relatedPathConventions ?? []) {
      addEdge(
        { kind: fromKind, id: e.id },
        { kind: 'path', id },
        'related-path',
        'actionHints.relatedPathConventions',
      );
    }
  }

  // Preset includes/references/composes.
  for (const preset of inspection.presetRegistry.list()) {
    for (const id of preset.includes.templateIds ?? []) {
      addEdge(
        { kind: 'preset', id: preset.id },
        { kind: 'template', id },
        'preset-references',
        'includes.templateIds',
      );
    }
    for (const id of preset.includes.pipelineIds ?? []) {
      addEdge(
        { kind: 'preset', id: preset.id },
        { kind: 'pipeline', id },
        'preset-references',
        'includes.pipelineIds',
      );
    }
    for (const id of preset.includes.ruleIds ?? []) {
      addEdge(
        { kind: 'preset', id: preset.id },
        { kind: 'rule', id },
        'preset-references',
        'includes.ruleIds',
      );
    }
    for (const id of preset.includes.pathConventionIds ?? []) {
      addEdge(
        { kind: 'preset', id: preset.id },
        { kind: 'path', id },
        'preset-references',
        'includes.pathConventionIds',
      );
    }
    for (const id of preset.includes.knowledgeIds ?? []) {
      addEdge(
        { kind: 'preset', id: preset.id },
        { kind: 'knowledge', id },
        'preset-references',
        'includes.knowledgeIds',
      );
    }
    for (const id of preset.composes ?? []) {
      addEdge(
        { kind: 'preset', id: preset.id },
        { kind: 'preset', id },
        'composes',
        'composes',
      );
    }
  }

  // Pipeline step references.
  for (const pipeline of inspection.pipelines) {
    for (const step of pipeline.steps ?? []) {
      for (const ref of step.references ?? []) {
        // Try template first, then knowledge.
        const tplKey = nodeKey('template', ref);
        const ruleKey = nodeKey('rule', ref);
        const pathKey = nodeKey('path', ref);
        const kKey = nodeKey('knowledge', ref);
        const targetKind = byId.has(tplKey)
          ? 'template'
          : byId.has(ruleKey)
            ? 'rule'
            : byId.has(pathKey)
              ? 'path'
              : byId.has(kKey)
                ? 'knowledge'
                : null;
        if (!targetKind) continue;
        addEdge(
          { kind: 'pipeline', id: pipeline.id },
          { kind: targetKind as GraphNodeKind, id: ref },
          'pipeline-step-references',
          `step ${step.id} references`,
        );
      }
    }
  }

  // Boundary rules: related rules / paths.
  for (const r of inspection.boundaryRegistry.list()) {
    for (const id of r.relatedRules ?? []) {
      addEdge(
        { kind: 'boundary', id: r.id },
        { kind: 'rule', id },
        'boundary-related-rule',
        'relatedRules',
      );
    }
    for (const id of r.relatedPathConventions ?? []) {
      addEdge(
        { kind: 'boundary', id: r.id },
        { kind: 'path', id },
        'boundary-related-path',
        'relatedPathConventions',
      );
    }
  }

  // Pack contributions: pack → its contributed items.
  for (const [id, src] of inspection.entrySources) {
    if (src.type !== 'pack' || !src.packageName) continue;
    addEdge(
      { kind: 'pack', id: src.packageName },
      { kind: 'knowledge', id },
      'pack-contributes',
      'knowledge entry',
    );
  }
  for (const [id, src] of inspection.templateSources) {
    if (src.type !== 'pack' || !src.packageName) continue;
    addEdge(
      { kind: 'pack', id: src.packageName },
      { kind: 'template', id },
      'pack-contributes',
      'template',
    );
  }
  for (const [id, src] of inspection.pipelineSources) {
    if (src.type !== 'pack' || !src.packageName) continue;
    addEdge(
      { kind: 'pack', id: src.packageName },
      { kind: 'pipeline', id },
      'pack-contributes',
      'pipeline',
    );
  }
  for (const [id, src] of inspection.presetSources) {
    if (src.type !== 'pack' || !src.packageName) continue;
    addEdge(
      { kind: 'pack', id: src.packageName },
      { kind: 'preset', id },
      'pack-contributes',
      'preset',
    );
  }
  for (const [id, src] of inspection.boundarySources) {
    if (src.type !== 'pack' || !src.packageName) continue;
    addEdge(
      { kind: 'pack', id: src.packageName },
      { kind: 'boundary', id },
      'pack-contributes',
      'boundary rule',
    );
  }

  return { nodes, edges, byId };
}

export interface IGraphPathStep {
  /** Composite node key `kind:id`. */
  node: string;
  /** Edge that led into this node (undefined for the start). */
  via?: { relation: GraphEdgeRelation; why: string };
}

export interface IGraphPath {
  found: boolean;
  steps: IGraphPathStep[];
  /** When found=false: short reason ("from missing", "to missing", "no path"). */
  reason?: string;
  /**
   * When found=false: a longer, kind-aware explanation that says why
   * the path doesn't exist and what to try instead. Renderers prefer
   * this over `reason` when present. Optional for back-compat — JSON
   * consumers that pin `reason` keep working.
   */
  explanation?: string;
}

/**
 * Find the shortest directed path (BFS) between two graph nodes. Edges are
 * treated in the direction they were added. Returns the node sequence with
 * the edge that landed on each step explained.
 */
export function findGraphPath(
  graph: IKnowledgeGraph,
  fromRef: { kind?: GraphNodeKind; id: string },
  toRef: { kind?: GraphNodeKind; id: string },
): IGraphPath {
  const fromNode = getGraphNode(graph, fromRef);
  const toNode = getGraphNode(graph, toRef);
  if (!fromNode) {
    return {
      found: false,
      steps: [],
      reason: 'from node not found',
      explanation: `From node "${fromRef.id}" not in the graph. Try \`shrk graph --type <kind>\` to list available ids.`,
    };
  }
  if (!toNode) {
    return {
      found: false,
      steps: [],
      reason: 'to node not found',
      explanation: `To node "${toRef.id}" not in the graph. Try \`shrk graph --type <kind>\` to list available ids.`,
    };
  }
  const fromKey = nodeKey(fromNode.node!.kind, fromNode.node!.id);
  const toKey = nodeKey(toNode.node!.kind, toNode.node!.id);
  if (fromKey === toKey) return { found: true, steps: [{ node: fromKey }] };
  const adj = new Map<string, { to: string; relation: GraphEdgeRelation; why: string }[]>();
  for (const e of graph.edges) {
    const list = adj.get(e.from) ?? [];
    list.push({ to: e.to, relation: e.relation, why: e.why });
    adj.set(e.from, list);
  }
  const parents = new Map<string, { from: string; relation: GraphEdgeRelation; why: string }>();
  const visited = new Set<string>([fromKey]);
  const queue: string[] = [fromKey];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === toKey) {
      const reversed: IGraphPathStep[] = [{ node: toKey }];
      let pivot = toKey;
      while (parents.has(pivot)) {
        const p = parents.get(pivot)!;
        reversed.push({ node: p.from, via: { relation: p.relation, why: p.why } });
        pivot = p.from;
      }
      const steps = reversed.reverse();
      const cleaned: IGraphPathStep[] = [];
      for (let i = 0; i < steps.length; i += 1) {
        const s = steps[i]!;
        if (i === 0) cleaned.push({ node: s.node });
        else cleaned.push({ node: s.node, via: steps[i - 1]!.via });
      }
      return { found: true, steps: cleaned };
    }
    for (const e of adj.get(cur) ?? []) {
      if (visited.has(e.to)) continue;
      visited.add(e.to);
      parents.set(e.to, { from: cur, relation: e.relation, why: e.why });
      queue.push(e.to);
    }
  }
  return {
    found: false,
    steps: [],
    reason: 'no path',
    explanation: explainNoPath(fromNode.node!.kind, toNode.node!.kind, fromRef.id, toRef.id),
  };
}

/**
 * Build a kind-aware "why is there no path" explanation. Most kinds in
 * the SharkCraft graph connect via tag overlap / appliesWhen / scope —
 * not via direct edges — so an empty BFS result is the expected case
 * for many queries. The explanation makes that visible.
 */
function explainNoPath(
  fromKind: GraphNodeKind,
  toKind: GraphNodeKind,
  fromId: string,
  toId: string,
): string {
  if (fromKind === toKind) {
    if (fromKind === 'rule') {
      return `No direct graph edge between ${fromKind}:${fromId} and ${toKind}:${toId}. Rules connect via tags / appliesWhen, not direct edges. Try: shrk rules get ${fromId} --json | jq '.appliesWhen,.tags'`;
    }
    if (fromKind === 'knowledge') {
      return `No direct graph edge between ${fromKind}:${fromId} and ${toKind}:${toId}. Knowledge entries connect via scope / tags, not direct edges. Try: shrk knowledge get ${fromId} --json | jq '.scope,.tags'`;
    }
    if (fromKind === 'path') {
      return `No direct graph edge between ${fromKind}:${fromId} and ${toKind}:${toId}. Path conventions are siblings — they don't reference each other. Try: shrk paths get ${fromId}`;
    }
    return `No direct graph edge between ${fromKind}:${fromId} and ${toKind}:${toId}.`;
  }
  // Heterogeneous pair — explain the actual connection model.
  const connector = HETEROGENEOUS_CONNECTORS[`${fromKind}->${toKind}`]
    ?? HETEROGENEOUS_CONNECTORS[`${toKind}->${fromKind}`];
  if (connector) {
    return `No direct edge between ${fromKind}:${fromId} and ${toKind}:${toId}. ${connector}`;
  }
  return `No direct edge between ${fromKind}:${fromId} and ${toKind}:${toId}. Graph edges exist for related-template / preset-references / pipeline-step-references / boundary-source-target relations — try \`shrk graph ${toId}\` to inspect ${toKind}:${toId}'s neighbours.`;
}

const HETEROGENEOUS_CONNECTORS: Readonly<Record<string, string>> = Object.freeze({
  'rule->pipeline': 'Rules attach to pipelines via tag overlap and appliesWhen — not direct edges. Try `shrk pipelines get <id>` to see the pipeline\'s tags and `shrk rules get <id>` to see the rule\'s appliesWhen.',
  'rule->template': 'Rules apply to templates via tag overlap — not direct edges. Try `shrk task "<task>" --json` to see the ranker output for both at once.',
  'rule->knowledge': 'Rules and knowledge entries don\'t connect via the graph. They are siblings in the asset registries — both surfaced together by the task-packet ranker.',
  'knowledge->pipeline': 'Knowledge entries reference pipelines indirectly via scope / appliesWhen. Try `shrk pipelines get <id>` to see the pipeline\'s tags.',
  'knowledge->template': 'Knowledge entries reference templates via the `related` field. Try `shrk knowledge get <id>` to see related ids.',
  'template->pipeline': 'Templates are referenced from pipeline steps via `cliCommands`. Try `shrk pipelines get <id>` and look for `gen <template-id>` in step commands.',
  'preset->knowledge': 'Presets bundle knowledge entries via `contributes`. Try `shrk presets get <id>` to see what the preset includes.',
  'preset->rule': 'Presets bundle rules via `contributes`. Try `shrk presets get <id>`.',
  'pack->knowledge': 'Packs ship knowledge entries. Try `shrk packs get <name>` to see what the pack contributes.',
  'pack->rule': 'Packs ship rules. Try `shrk packs get <name>`.',
});

/**
 * Get a node + its incoming/outgoing edges grouped by kind.
 */
export function getGraphNode(
  graph: IKnowledgeGraph,
  ref: { kind?: GraphNodeKind; id: string },
): {
  node: IGraphNode | null;
  incoming: IGraphEdge[];
  outgoing: IGraphEdge[];
} | null {
  let node: IGraphNode | null = null;
  if (ref.kind) {
    node = graph.byId.get(nodeKey(ref.kind, ref.id)) ?? null;
  } else {
    // Try each kind.
    for (const k of [
      'preset',
      'template',
      'pipeline',
      'rule',
      'path',
      'knowledge',
      'boundary',
      'pack',
      'doc',
    ] as GraphNodeKind[]) {
      const found = graph.byId.get(nodeKey(k, ref.id));
      if (found) {
        node = found;
        break;
      }
    }
  }
  if (!node) return null;
  const key = nodeKey(node.kind, node.id);
  return {
    node,
    outgoing: graph.edges.filter((e) => e.from === key),
    incoming: graph.edges.filter((e) => e.to === key),
  };
}
