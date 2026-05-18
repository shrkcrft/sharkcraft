import type { ITemplateDefinition } from '@shrkcrft/templates';
import type { IPipelineDefinition } from '@shrkcrft/pipelines';
import type { IFeatureBundle } from './feature-bundle.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const PLAN_DEP_GRAPH_SCHEMA = 'sharkcraft.plan-dependency-graph/v1';

export interface IPlanDepEdge {
  from: string;
  to: string;
  reason: string;
}

export interface IPlanDepGraph {
  schema: typeof PLAN_DEP_GRAPH_SCHEMA;
  bundleId: string;
  nodes: readonly { id: string; templateId: string }[];
  edges: readonly IPlanDepEdge[];
  /** Topological order (best-effort; cycles are reported in `cycles`). */
  order: readonly string[];
  cycles: readonly (readonly string[])[];
}

function templateMeta(t: ITemplateDefinition): {
  related: readonly string[];
  dependsOn: readonly string[];
  provides: readonly string[];
  requires: readonly string[];
} {
  const meta = t as unknown as {
    relatedTemplates?: readonly string[];
    dependsOnTemplates?: readonly string[];
    provides?: readonly string[];
    requires?: readonly string[];
  };
  return {
    related: meta.relatedTemplates ?? [],
    dependsOn: meta.dependsOnTemplates ?? [],
    provides: meta.provides ?? [],
    requires: meta.requires ?? [],
  };
}

function pipelineOrder(p: IPipelineDefinition | undefined): readonly string[] {
  if (!p) return [];
  const out: string[] = [];
  for (const step of p.steps) {
    // Pipeline steps reference templates via `references[]` rather than a
    // dedicated `templateId` field. We treat short slug-like references as
    // template ids — a generous heuristic that's fine for ordering.
    for (const ref of step.references ?? []) {
      if (/^[a-z][a-z0-9-]+$/.test(ref)) out.push(ref);
    }
  }
  return out;
}

export function buildPlanDependencyGraph(
  inspection: ISharkcraftInspection,
  bundle: IFeatureBundle,
): IPlanDepGraph {
  // Fast path: if the bundle already has persisted dependencies, return them
  // directly. Avoids re-scanning templates/pipelines on read-only calls.
  if (bundle.dependencies && bundle.dependencies.length > 0) {
    const nodes = bundle.plans.map((p) => ({ id: p.name, templateId: p.templateId }));
    const edges = bundle.dependencies.map((e) => ({ from: e.from, to: e.to, reason: e.reason }));
    const { order, cycles } = topoSort(nodes.map((n) => n.id), edges);
    return {
      schema: PLAN_DEP_GRAPH_SCHEMA,
      bundleId: bundle.id,
      nodes,
      edges,
      order,
      cycles,
    };
  }
  const nodes = bundle.plans.map((p) => ({ id: p.name, templateId: p.templateId }));
  const edges: IPlanDepEdge[] = [];

  const byTemplate = new Map<string, string[]>();
  for (const p of bundle.plans) {
    const list = byTemplate.get(p.templateId) ?? [];
    list.push(p.name);
    byTemplate.set(p.templateId, list);
  }

  // 1) Explicit dependsOnTemplates / requires.
  for (const plan of bundle.plans) {
    const t = inspection.templateRegistry.get(plan.templateId);
    if (!t) continue;
    const m = templateMeta(t);
    for (const depTpl of m.dependsOn) {
      for (const target of byTemplate.get(depTpl) ?? []) {
        if (target === plan.name) continue;
        edges.push({ from: target, to: plan.name, reason: `template ${plan.templateId} dependsOnTemplates ${depTpl}` });
      }
    }
    for (const req of m.requires) {
      for (const other of bundle.plans) {
        if (other.name === plan.name) continue;
        const ot = inspection.templateRegistry.get(other.templateId);
        if (!ot) continue;
        if (templateMeta(ot).provides.includes(req)) {
          edges.push({ from: other.name, to: plan.name, reason: `requires ${req} provided by ${other.templateId}` });
        }
      }
    }
  }

  // 2) Path-prefix: a plan that writes a base interface should come before
  //    implementers that import from it.
  for (const a of bundle.plans) {
    for (const b of bundle.plans) {
      if (a.name === b.name) continue;
      const aTargets = a.expectedTargets ?? [];
      const bTargets = b.expectedTargets ?? [];
      if (aTargets.some((p) => /(interface|contract|base|abstract)\b/i.test(p))) {
        if (bTargets.some((p) => /(impl|implementation|service|adapter|provider)\b/i.test(p))) {
          edges.push({ from: a.name, to: b.name, reason: 'contract → implementation' });
        }
      }
    }
  }

  // 3) Pipeline step order.
  if (bundle.pipelineId) {
    const order = pipelineOrder(inspection.pipelineRegistry.get(bundle.pipelineId) ?? undefined);
    for (let i = 0; i < order.length - 1; i += 1) {
      const a = order[i]!;
      const b = order[i + 1]!;
      for (const af of byTemplate.get(a) ?? []) {
        for (const bf of byTemplate.get(b) ?? []) {
          if (af === bf) continue;
          edges.push({ from: af, to: bf, reason: `pipeline ${bundle.pipelineId} step order` });
        }
      }
    }
  }

  // Dedup edges by (from, to).
  const seen = new Set<string>();
  const dedup: IPlanDepEdge[] = [];
  for (const e of edges) {
    const k = `${e.from}->${e.to}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(e);
  }

  const { order, cycles } = topoSort(
    nodes.map((n) => n.id),
    dedup,
  );

  return {
    schema: PLAN_DEP_GRAPH_SCHEMA,
    bundleId: bundle.id,
    nodes,
    edges: dedup,
    order,
    cycles,
  };
}

function topoSort(
  nodes: readonly string[],
  edges: readonly IPlanDepEdge[],
): { order: string[]; cycles: string[][] } {
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    inDeg.set(n, 0);
    adj.set(n, []);
  }
  for (const e of edges) {
    if (!inDeg.has(e.from) || !inDeg.has(e.to)) continue;
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
    adj.get(e.from)!.push(e.to);
  }
  const order: string[] = [];
  const ready: string[] = [];
  for (const [n, d] of inDeg) if (d === 0) ready.push(n);
  ready.sort();
  while (ready.length) {
    const n = ready.shift()!;
    order.push(n);
    for (const next of adj.get(n) ?? []) {
      const d = (inDeg.get(next) ?? 0) - 1;
      inDeg.set(next, d);
      if (d === 0) ready.push(next);
    }
    ready.sort();
  }
  // Detect cycles: anything with leftover in-degree.
  const leftover = nodes.filter((n) => (inDeg.get(n) ?? 0) > 0);
  const cycles: string[][] = leftover.length > 0 ? [leftover] : [];
  return { order: [...order, ...leftover], cycles };
}

export function renderGraphDot(g: IPlanDepGraph): string {
  const lines = ['digraph plan_deps {', '  rankdir=LR;'];
  for (const n of g.nodes) lines.push(`  "${n.id}" [label="${n.id}\\n(${n.templateId})"];`);
  for (const e of g.edges) lines.push(`  "${e.from}" -> "${e.to}" [label="${e.reason.slice(0, 32)}"];`);
  lines.push('}');
  return lines.join('\n') + '\n';
}

export function renderGraphMermaid(g: IPlanDepGraph): string {
  const lines = ['```mermaid', 'graph LR'];
  for (const e of g.edges) {
    lines.push(`  ${sanitize(e.from)} --> ${sanitize(e.to)}`);
  }
  for (const n of g.nodes) {
    lines.push(`  ${sanitize(n.id)}[${n.id}]`);
  }
  lines.push('```');
  return lines.join('\n') + '\n';
}

export function renderGraphText(g: IPlanDepGraph): string {
  const lines: string[] = [];
  lines.push(`Plan dependency graph for ${g.bundleId}`);
  lines.push(`  ${g.nodes.length} nodes, ${g.edges.length} edges`);
  lines.push(`  Order: ${g.order.join(' → ') || '(empty)'}`);
  if (g.cycles.length > 0) {
    lines.push(`  Cycles: ${g.cycles.map((c) => c.join(','))}`);
  }
  for (const e of g.edges) lines.push(`    ${e.from} → ${e.to}    (${e.reason})`);
  return lines.join('\n') + '\n';
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, '_');
}
