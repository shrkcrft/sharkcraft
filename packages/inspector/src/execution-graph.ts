/**
 * Task execution graph.
 *
 * Combine intent, risk, memory (when present), contract, constructs,
 * policies, boundaries, playbooks, templates, plans, gates, validations,
 * and reports into a structured graph (nodes + edges). Pure data — no
 * execution, no writes.
 */
import {
  buildAgentContract,
  type IAgentContract,
} from './agent-contract.ts';
import { loadRepositoryMemory, memoryRiskForTask, type IMemoryRiskReport } from './repo-memory.ts';
import { classifyChangeIntent, type IChangeIntent } from './change-intent.ts';
import { buildTaskRiskReport, type ITaskRiskReport } from './task-risk.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const EXECUTION_GRAPH_SCHEMA = 'sharkcraft.execution-graph/v1';

export enum ExecutionNodeKind {
  Task = 'task',
  Intent = 'intent',
  Risk = 'risk',
  Memory = 'memory',
  Contract = 'contract',
  Construct = 'construct',
  Policy = 'policy',
  Boundary = 'boundary',
  Playbook = 'playbook',
  Template = 'template',
  Plan = 'plan',
  ReviewGate = 'review-gate',
  HumanApproval = 'human-approval',
  Validation = 'validation',
  ReportArtifact = 'report-artifact',
  Done = 'done',
}

export enum ExecutionEdgeKind {
  Requires = 'requires',
  Informs = 'informs',
  Blocks = 'blocks',
  Validates = 'validates',
  Produces = 'produces',
  Reviews = 'reviews',
  Forbids = 'forbids',
  Recommends = 'recommends',
}

export interface IExecutionNode {
  id: string;
  kind: ExecutionNodeKind;
  label: string;
  detail?: string;
}

export interface IExecutionEdge {
  from: string;
  to: string;
  kind: ExecutionEdgeKind;
  detail?: string;
}

export interface ITaskExecutionGraph {
  schema: typeof EXECUTION_GRAPH_SCHEMA;
  generatedAt: string;
  task: string;
  role: string;
  mode: string;
  intent: IChangeIntent;
  taskRisk: ITaskRiskReport;
  contract: IAgentContract;
  memoryRisk?: IMemoryRiskReport;
  nodes: readonly IExecutionNode[];
  edges: readonly IExecutionEdge[];
  notes: readonly string[];
}

export interface IBuildExecutionGraphOptions {
  role?: string;
  mode?: string;
  files?: readonly string[];
  since?: string;
  staged?: boolean;
}

function n(id: string, kind: ExecutionNodeKind, label: string, detail?: string): IExecutionNode {
  return detail === undefined ? { id, kind, label } : { id, kind, label, detail };
}

function e(from: string, to: string, kind: ExecutionEdgeKind, detail?: string): IExecutionEdge {
  return detail === undefined ? { from, to, kind } : { from, to, kind, detail };
}

export async function buildTaskExecutionGraph(
  task: string,
  inspection: ISharkcraftInspection,
  options: IBuildExecutionGraphOptions = {},
): Promise<ITaskExecutionGraph> {
  const trimmed = (task || '').trim();
  const intent = await classifyChangeIntent(trimmed, inspection);
  const risk = await buildTaskRiskReport(trimmed, inspection, {
    ...(options.files ? { files: options.files } : {}),
    ...(options.since ? { since: options.since } : {}),
    ...(options.staged ? { staged: true } : {}),
    includeMemory: true,
  });
  const contract = await buildAgentContract(trimmed, inspection, {
    ...(options.role ? { role: options.role } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.files ? { files: options.files } : {}),
    ...(options.since ? { since: options.since } : {}),
    ...(options.staged ? { staged: true } : {}),
  });

  const memoryIndex = loadRepositoryMemory(inspection.projectRoot);
  const memoryRisk = memoryIndex ? memoryRiskForTask(memoryIndex, trimmed) : undefined;

  const nodes: IExecutionNode[] = [];
  const edges: IExecutionEdge[] = [];

  nodes.push(n('task', ExecutionNodeKind.Task, `Task: ${trimmed || '(empty)'}`));
  nodes.push(
    n('intent', ExecutionNodeKind.Intent, `Intent: ${intent.kind}`, intent.suggestedFirstCommand),
  );
  nodes.push(
    n('risk', ExecutionNodeKind.Risk, `Risk: ${risk.riskLevel} (score ${risk.score})`),
  );
  if (memoryRisk) {
    nodes.push(
      n('memory', ExecutionNodeKind.Memory, `Memory: ${memoryRisk.recommendation}`),
    );
  }
  nodes.push(n('contract', ExecutionNodeKind.Contract, `Contract: ${contract.role}/${contract.mode}`));

  edges.push(e('task', 'intent', ExecutionEdgeKind.Informs));
  edges.push(e('task', 'risk', ExecutionEdgeKind.Informs));
  if (memoryRisk) edges.push(e('task', 'memory', ExecutionEdgeKind.Informs));
  edges.push(e('intent', 'contract', ExecutionEdgeKind.Informs));
  edges.push(e('risk', 'contract', ExecutionEdgeKind.Informs));
  if (memoryRisk) edges.push(e('memory', 'contract', ExecutionEdgeKind.Informs));

  // Constructs
  for (const c of contract.relevantConstructs.slice(0, 8)) {
    const id = `construct:${c}`;
    nodes.push(n(id, ExecutionNodeKind.Construct, c));
    edges.push(e('contract', id, ExecutionEdgeKind.Informs));
  }

  // Policies / boundaries
  for (const p of contract.relevantPolicies.slice(0, 5)) {
    const id = `policy:${p.slice(0, 60)}`;
    nodes.push(n(id, ExecutionNodeKind.Policy, p));
    edges.push(e('contract', id, ExecutionEdgeKind.Reviews));
  }
  for (const b of contract.relevantBoundaries.slice(0, 5)) {
    const id = `boundary:${b.slice(0, 60)}`;
    nodes.push(n(id, ExecutionNodeKind.Boundary, b));
    edges.push(e('contract', id, ExecutionEdgeKind.Reviews));
  }

  // Playbooks
  for (const p of contract.relevantPlaybooks.slice(0, 5)) {
    const id = `playbook:${p}`;
    nodes.push(n(id, ExecutionNodeKind.Playbook, p));
    edges.push(e('contract', id, ExecutionEdgeKind.Recommends));
  }

  // Templates
  for (const t of contract.relevantTemplates.slice(0, 5)) {
    const id = `template:${t}`;
    nodes.push(n(id, ExecutionNodeKind.Template, t));
    edges.push(e('contract', id, ExecutionEdgeKind.Produces));
  }

  // Plans
  for (const planReview of contract.requiredPlanReviews) {
    const id = `plan:${planReview.slice(0, 60)}`;
    nodes.push(n(id, ExecutionNodeKind.Plan, planReview));
    edges.push(e('contract', id, ExecutionEdgeKind.Requires));
  }

  // Review gates
  for (const r of contract.requiredReviews) {
    const id = `review:${r.slice(0, 60)}`;
    nodes.push(n(id, ExecutionNodeKind.ReviewGate, r));
    edges.push(e('contract', id, ExecutionEdgeKind.Requires));
  }

  // Human approval
  if (contract.humanApprovalGates.length > 0) {
    nodes.push(
      n(
        'human-approval',
        ExecutionNodeKind.HumanApproval,
        'Human approval gate',
        contract.humanApprovalGates.join(' / '),
      ),
    );
    edges.push(e('contract', 'human-approval', ExecutionEdgeKind.Requires));
  }

  // Validations
  for (const v of contract.requiredValidations) {
    const id = `validation:${v.slice(0, 60)}`;
    nodes.push(n(id, ExecutionNodeKind.Validation, v));
    edges.push(e('contract', id, ExecutionEdgeKind.Validates));
  }

  // Report artefacts
  const artefacts: string[] = [];
  artefacts.push('brief');
  artefacts.push('risk');
  if (contract.requiredPlanReviews.length) artefacts.push('plan simulation');
  artefacts.push('validation report');
  for (const a of artefacts) {
    const id = `report:${a}`;
    nodes.push(n(id, ExecutionNodeKind.ReportArtifact, a));
    edges.push(e('contract', id, ExecutionEdgeKind.Produces));
  }

  // Done
  nodes.push(n('done', ExecutionNodeKind.Done, 'Definition of done', contract.definitionOfDone.join(' / ')));
  // Edges from each validation/approval to done.
  for (const v of contract.requiredValidations) edges.push(e(`validation:${v.slice(0, 60)}`, 'done', ExecutionEdgeKind.Validates));
  if (contract.humanApprovalGates.length > 0) edges.push(e('human-approval', 'done', ExecutionEdgeKind.Validates));

  // Forbids edges from contract to each forbidden command.
  for (const f of contract.forbiddenCommands.slice(0, 5)) {
    const id = `forbid:${f.slice(0, 60)}`;
    nodes.push(n(id, ExecutionNodeKind.Validation, f));
    edges.push(e('contract', id, ExecutionEdgeKind.Forbids));
  }

  // Blocks: if risk requires approval, contract blocks done until approval.
  if (contract.taskRisk.humanApprovalRequired) {
    edges.push(e('human-approval', 'done', ExecutionEdgeKind.Requires));
  }

  return {
    schema: EXECUTION_GRAPH_SCHEMA,
    generatedAt: new Date().toISOString(),
    task: trimmed,
    role: contract.role,
    mode: contract.mode,
    intent,
    taskRisk: risk,
    contract,
    ...(memoryRisk ? { memoryRisk } : {}),
    nodes,
    edges,
    notes: [
      'Read-only. No execution, no writes.',
      'Nodes are derived from the agent contract; edges are deterministic.',
    ],
  };
}

export function renderExecutionGraphText(g: ITaskExecutionGraph): string {
  let out = `=== Task execution graph ===\n`;
  out += `  task    ${g.task || '(empty)'}\n`;
  out += `  role    ${g.role}\n`;
  out += `  mode    ${g.mode}\n`;
  out += `  intent  ${g.intent.kind}\n`;
  out += `  risk    ${g.taskRisk.riskLevel}\n`;
  out += `  nodes   ${g.nodes.length}\n`;
  out += `  edges   ${g.edges.length}\n\n`;
  out += `Nodes:\n`;
  for (const n0 of g.nodes) out += `  [${n0.kind}] ${n0.id}  ${n0.label}\n`;
  out += `\nEdges:\n`;
  for (const e0 of g.edges) out += `  ${e0.from} --${e0.kind}--> ${e0.to}\n`;
  return out;
}

export function renderExecutionGraphMarkdown(g: ITaskExecutionGraph): string {
  let out = `# Task execution graph\n\n`;
  out += `- **task**: ${g.task || '(empty)'}\n`;
  out += `- **role**: ${g.role}\n`;
  out += `- **mode**: ${g.mode}\n`;
  out += `- **intent**: ${g.intent.kind}\n`;
  out += `- **risk**: ${g.taskRisk.riskLevel}\n`;
  out += `- **nodes**: ${g.nodes.length} / **edges**: ${g.edges.length}\n\n`;
  out += `## Nodes\n\n`;
  for (const n0 of g.nodes) out += `- \`${n0.id}\` (${n0.kind}) — ${n0.label}\n`;
  out += `\n## Edges\n\n`;
  for (const e0 of g.edges) out += `- \`${e0.from}\` —${e0.kind}→ \`${e0.to}\`\n`;
  return out + '\n';
}

function mermaidLabel(label: string): string {
  // Escape pipe and quotes; keep things one-line.
  return label.replace(/"/g, '\\"').replace(/\|/g, '/').replace(/[\r\n]+/g, ' ');
}

function mermaidId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_');
}

export function renderExecutionGraphMermaid(g: ITaskExecutionGraph): string {
  let out = `flowchart TD\n`;
  for (const node of g.nodes) {
    out += `  ${mermaidId(node.id)}["${mermaidLabel(`${node.label} [${node.kind}]`)}"]\n`;
  }
  for (const edge of g.edges) {
    out += `  ${mermaidId(edge.from)} -->|${mermaidLabel(edge.kind)}| ${mermaidId(edge.to)}\n`;
  }
  return out;
}

function dotEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
}

function dotId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_');
}

export function renderExecutionGraphDot(g: ITaskExecutionGraph): string {
  let out = `digraph TaskExecutionGraph {\n`;
  out += `  rankdir=TB;\n`;
  out += `  node [shape=box, fontname="Helvetica"];\n`;
  for (const node of g.nodes) {
    out += `  ${dotId(node.id)} [label="${dotEscape(node.label)}\\n[${node.kind}]"];\n`;
  }
  for (const edge of g.edges) {
    out += `  ${dotId(edge.from)} -> ${dotId(edge.to)} [label="${dotEscape(edge.kind)}"];\n`;
  }
  out += `}\n`;
  return out;
}

// Clustered DOT renderer. Groups nodes into subgraph clusters by kind.
// Stable colors + shapes per cluster; pure data (no external rendering).
interface IClusterStyle {
  label: string;
  color: string;
  fillColor: string;
  shape: string;
}

const CLUSTER_INTENT_RISK: readonly ExecutionNodeKind[] = [
  ExecutionNodeKind.Task,
  ExecutionNodeKind.Intent,
  ExecutionNodeKind.Risk,
  ExecutionNodeKind.Memory,
];
const CLUSTER_CONTRACT_GATES: readonly ExecutionNodeKind[] = [
  ExecutionNodeKind.Contract,
  ExecutionNodeKind.ReviewGate,
  ExecutionNodeKind.HumanApproval,
];
const CLUSTER_CONSTRUCTS_POLICIES: readonly ExecutionNodeKind[] = [
  ExecutionNodeKind.Construct,
  ExecutionNodeKind.Policy,
  ExecutionNodeKind.Boundary,
  ExecutionNodeKind.Playbook,
  ExecutionNodeKind.Template,
];
const CLUSTER_PLANS: readonly ExecutionNodeKind[] = [ExecutionNodeKind.Plan];
const CLUSTER_VALIDATION: readonly ExecutionNodeKind[] = [
  ExecutionNodeKind.Validation,
  ExecutionNodeKind.ReportArtifact,
];
const CLUSTER_DONE: readonly ExecutionNodeKind[] = [ExecutionNodeKind.Done];

const CLUSTERS: readonly { id: string; kinds: readonly ExecutionNodeKind[]; style: IClusterStyle }[] = [
  {
    id: 'cluster_intent_risk',
    kinds: CLUSTER_INTENT_RISK,
    style: { label: 'Intent · Risk · Memory', color: '#1f77b4', fillColor: '#dbeafe', shape: 'box' },
  },
  {
    id: 'cluster_contract_gates',
    kinds: CLUSTER_CONTRACT_GATES,
    style: { label: 'Contract · Gates', color: '#9467bd', fillColor: '#ede9fe', shape: 'hexagon' },
  },
  {
    id: 'cluster_constructs_policies',
    kinds: CLUSTER_CONSTRUCTS_POLICIES,
    style: { label: 'Constructs · Policies · Boundaries', color: '#2ca02c', fillColor: '#dcfce7', shape: 'box' },
  },
  {
    id: 'cluster_plans',
    kinds: CLUSTER_PLANS,
    style: { label: 'Plans · Simulation', color: '#ff7f0e', fillColor: '#ffedd5', shape: 'note' },
  },
  {
    id: 'cluster_validation',
    kinds: CLUSTER_VALIDATION,
    style: { label: 'Validation · Reports', color: '#17becf', fillColor: '#cffafe', shape: 'oval' },
  },
  {
    id: 'cluster_done',
    kinds: CLUSTER_DONE,
    style: { label: 'Done', color: '#d62728', fillColor: '#fee2e2', shape: 'doublecircle' },
  },
];

function clusterFor(kind: ExecutionNodeKind): (typeof CLUSTERS)[number] | null {
  return CLUSTERS.find((c) => c.kinds.includes(kind)) ?? null;
}

export function renderExecutionGraphClusteredDot(g: ITaskExecutionGraph): string {
  let out = `digraph TaskExecutionGraph {\n`;
  out += `  rankdir=TB;\n`;
  out += `  compound=true;\n`;
  out += `  node [fontname="Helvetica"];\n`;
  out += `  edge [fontname="Helvetica"];\n\n`;

  // Index nodes by cluster.
  const byCluster = new Map<string, IExecutionNode[]>();
  const unclustered: IExecutionNode[] = [];
  for (const node of g.nodes) {
    const c = clusterFor(node.kind);
    if (!c) {
      unclustered.push(node);
      continue;
    }
    if (!byCluster.has(c.id)) byCluster.set(c.id, []);
    byCluster.get(c.id)!.push(node);
  }

  for (const cluster of CLUSTERS) {
    const nodes = byCluster.get(cluster.id);
    if (!nodes || nodes.length === 0) continue;
    out += `  subgraph ${cluster.id} {\n`;
    out += `    label="${dotEscape(cluster.style.label)}";\n`;
    out += `    style="rounded,filled";\n`;
    out += `    fillcolor="${cluster.style.fillColor}";\n`;
    out += `    color="${cluster.style.color}";\n`;
    out += `    node [shape=${cluster.style.shape}, color="${cluster.style.color}", style=filled, fillcolor="white"];\n`;
    for (const node of nodes) {
      out += `    ${dotId(node.id)} [label="${dotEscape(node.label)}\\n[${node.kind}]"];\n`;
    }
    out += `  }\n\n`;
  }

  if (unclustered.length > 0) {
    out += `  subgraph cluster_other {\n`;
    out += `    label="Other";\n`;
    out += `    style="rounded,dashed";\n`;
    for (const node of unclustered) {
      out += `    ${dotId(node.id)} [label="${dotEscape(node.label)}\\n[${node.kind}]", shape=box];\n`;
    }
    out += `  }\n\n`;
  }

  for (const edge of g.edges) {
    out += `  ${dotId(edge.from)} -> ${dotId(edge.to)} [label="${dotEscape(edge.kind)}"];\n`;
  }
  out += `}\n`;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Query surface
// ─────────────────────────────────────────────────────────────────────────────

export interface IExecutionGraphQueryResult {
  schema: typeof EXECUTION_GRAPH_SCHEMA;
  query: string;
  matchedNodes: readonly IExecutionNode[];
  matchedEdges: readonly IExecutionEdge[];
  notes: readonly string[];
}

/**
 * Query syntax (lowercased token before ':'):
 *  - blocks:<nodeId>       → nodes/edges blocking the named node
 *  - kind:<kind>           → nodes of that kind
 *  - edge:<kind>           → edges of that kind
 *  - text:<substring>      → nodes whose id/label/detail contains substring
 */
export function queryExecutionGraph(
  graph: ITaskExecutionGraph,
  query: string,
): IExecutionGraphQueryResult {
  const q = (query ?? '').trim();
  const notes: string[] = [];
  if (!q) {
    return {
      schema: EXECUTION_GRAPH_SCHEMA,
      query: q,
      matchedNodes: [],
      matchedEdges: [],
      notes: ['Empty query.'],
    };
  }
  const colon = q.indexOf(':');
  if (colon < 0) {
    return {
      schema: EXECUTION_GRAPH_SCHEMA,
      query: q,
      matchedNodes: [],
      matchedEdges: [],
      notes: ['Query must use the form `<filter>:<value>` (e.g. `blocks:done`, `kind:human-approval`).'],
    };
  }
  const filter = q.slice(0, colon).toLowerCase();
  const value = q.slice(colon + 1).trim();

  const matchedNodes: IExecutionNode[] = [];
  const matchedEdges: IExecutionEdge[] = [];

  switch (filter) {
    case 'blocks': {
      const targetId = value;
      // Edges whose `to` is the target with kind requires/blocks (or whose
      // `from` is the target with kind blocks). We surface all reachable
      // upstream gating nodes.
      const upstream = new Set<string>();
      const queue: string[] = [targetId];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        for (const e of graph.edges) {
          if (e.to !== cur) continue;
          if (
            e.kind === ExecutionEdgeKind.Requires ||
            e.kind === ExecutionEdgeKind.Blocks ||
            e.kind === ExecutionEdgeKind.Validates
          ) {
            matchedEdges.push(e);
            if (!upstream.has(e.from)) {
              upstream.add(e.from);
              queue.push(e.from);
            }
          }
        }
      }
      for (const id of upstream) {
        const node = graph.nodes.find((n) => n.id === id);
        if (node) matchedNodes.push(node);
      }
      if (matchedNodes.length === 0) notes.push(`No nodes block ${targetId}.`);
      break;
    }
    case 'kind': {
      for (const n of graph.nodes) if ((n.kind as string).toLowerCase() === value.toLowerCase()) matchedNodes.push(n);
      if (matchedNodes.length === 0) notes.push(`No nodes of kind ${value}.`);
      break;
    }
    case 'edge': {
      for (const e of graph.edges) if ((e.kind as string).toLowerCase() === value.toLowerCase()) matchedEdges.push(e);
      if (matchedEdges.length === 0) notes.push(`No edges of kind ${value}.`);
      break;
    }
    case 'text': {
      const lv = value.toLowerCase();
      for (const n of graph.nodes) {
        const blob = `${n.id} ${n.label} ${n.detail ?? ''}`.toLowerCase();
        if (blob.includes(lv)) matchedNodes.push(n);
      }
      if (matchedNodes.length === 0) notes.push(`No node text matches "${value}".`);
      break;
    }
    default: {
      notes.push(`Unknown filter "${filter}". Try: blocks, kind, edge, text.`);
      break;
    }
  }

  return {
    schema: EXECUTION_GRAPH_SCHEMA,
    query: q,
    matchedNodes,
    matchedEdges,
    notes,
  };
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderExecutionGraphHtml(g: ITaskExecutionGraph): string {
  const mermaid = renderExecutionGraphMermaid(g);
  // No JS — just pre-formatted mermaid source. Render with any local renderer
  // that supports this. This file is safe to open in a browser.
  return `<!doctype html><html><head><meta charset="utf-8"><title>Task execution graph</title></head><body>
<h1>Task execution graph</h1>
<pre><code class="language-mermaid">${htmlEscape(mermaid)}</code></pre>
</body></html>
`;
}
