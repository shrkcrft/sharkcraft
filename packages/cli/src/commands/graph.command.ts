import { mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  analyzeImportGraph,
  buildKnowledgeGraph,
  findGraphPath,
  getGraphNode,
  inspectSharkcraft,
} from '@shrkcrft/inspector';
import type { GraphNodeKind, IKnowledgeGraph } from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';

const KNOWN_KINDS: GraphNodeKind[] = [
  'knowledge',
  'rule',
  'path',
  'template',
  'pipeline',
  'preset',
  'pack',
  'boundary',
  'doc',
];

export const graphCommand: ICommandHandler = {
  name: 'graph',
  description:
    'Show the SharkCraft knowledge graph: nodes (knowledge/rules/paths/templates/pipelines/presets/packs/boundaries) and edges (related-template, preset-references, pipeline-step-references, …). Supports text|json|dot|mermaid output and an `export` subcommand for writing to file.',
  usage:
    'shrk [--cwd <dir>] graph [<id>] [--type <kind>] [--format text|json|dot|mermaid] [--output <file>] [--json] | shrk graph export --format dot|mermaid --output <file>',
  async run(args: ParsedArgs): Promise<number> {
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const graph = buildKnowledgeGraph(inspection);
    const sub = args.positional[0];
    const typeFlag = flagString(args, 'type') as GraphNodeKind | undefined;
    const formatFlag = (flagString(args, 'format') ?? 'text') as
      | 'text'
      | 'json'
      | 'dot'
      | 'mermaid';
    const outputFlag = flagString(args, 'output');

    // `shrk graph imports` — import-graph analysis.
    if (sub === 'imports') {
      const cwd = resolveCwd(args);
      const analysis = analyzeImportGraph(cwd);
      const wantJson = flagBool(args, 'json');
      const wantCycles = flagBool(args, 'cycles');
      const wantFanIn = flagBool(args, 'fan-in');
      const wantFanOut = flagBool(args, 'fan-out');
      const wantOrphans = flagBool(args, 'orphans');
      if (wantJson) {
        process.stdout.write(asJson(analysis) + '\n');
        return 0;
      }
      process.stdout.write(header('Import graph analysis'));
      process.stdout.write(kv('files scanned', String(analysis.filesScanned)) + '\n');
      process.stdout.write(kv('workspace packages', String(analysis.packageCount)) + '\n');
      if (!wantCycles && !wantFanIn && !wantFanOut && !wantOrphans) {
        process.stdout.write(`cycles=${analysis.cycles.length}  orphans=${analysis.orphans.length}  unused=${analysis.unusedPublicEntrypoints.length}\n`);
        process.stdout.write('Top fan-in:\n');
        for (const f of analysis.topFanIn.slice(0, 5)) process.stdout.write(`  ${f.in}  ${f.file}\n`);
        return 0;
      }
      if (wantCycles) {
        for (const c of analysis.cycles) process.stdout.write(`cycle: ${c.nodes.join(' → ')}\n`);
      }
      if (wantFanIn) {
        for (const f of analysis.topFanIn) process.stdout.write(`${f.in}\t${f.file}\n`);
      }
      if (wantFanOut) {
        for (const f of analysis.topFanOut) process.stdout.write(`${f.out}\t${f.file}\n`);
      }
      if (wantOrphans) {
        for (const f of analysis.orphans) process.stdout.write(`${f}\n`);
      }
      return 0;
    }
    // `shrk graph export --format dot|mermaid --output <file>`.
    if (sub === 'export') {
      if (formatFlag !== 'dot' && formatFlag !== 'mermaid' && formatFlag !== 'json') {
        process.stderr.write('Usage: shrk graph export --format dot|mermaid|json --output <file>\n');
        return 2;
      }
      if (!outputFlag) {
        process.stderr.write('Usage: shrk graph export --format dot|mermaid|json --output <file>\n');
        return 2;
      }
      return exportGraph(args, graph, formatFlag, outputFlag);
    }

    // `shrk graph why <from> <to>` — shortest-path search.
    if (sub === 'why') {
      const fromId = args.positional[1];
      const toId = args.positional[2];
      if (!fromId || !toId) {
        process.stderr.write('Usage: shrk graph why <fromId> <toId>\n');
        return 2;
      }
      const path = findGraphPath(graph, { id: fromId }, { id: toId });
      if (flagBool(args, 'json')) {
        process.stdout.write(asJson(path) + '\n');
        return path.found ? 0 : 1;
      }
      process.stdout.write(header(`Graph why: ${fromId} → ${toId}`));
      if (!path.found) {
        // Prefer the kind-aware explanation when available (rules don't
        // connect to rules directly, etc.). Fall back to the short reason
        // for older inspectors that don't populate `explanation`.
        process.stdout.write(`${path.explanation ?? path.reason ?? 'No path: unknown'}\n`);
        return 1;
      }
      for (let i = 0; i < path.steps.length; i += 1) {
        const s = path.steps[i]!;
        if (s.via) {
          process.stdout.write(
            `  → (${s.via.relation}) ${s.via.why}\n`,
          );
        }
        process.stdout.write(`  ${i + 1}. ${s.node}\n`);
      }
      return 0;
    }

    const id = sub;
    if (id) {
      const node = getGraphNode(graph, typeFlag ? { kind: typeFlag, id } : { id });
      if (!node) {
        process.stderr.write(`No graph node for "${id}".\n`);
        return 1;
      }
      // Subgraph export (single node + neighbours) in dot/mermaid format.
      if (formatFlag === 'dot' || formatFlag === 'mermaid') {
        const body = formatFlag === 'dot' ? renderDotForNode(node) : renderMermaidForNode(node);
        if (outputFlag) {
          writeOutput(args, outputFlag, body);
          return 0;
        }
        process.stdout.write(body);
        return 0;
      }
      if (flagBool(args, 'json')) {
        process.stdout.write(asJson(node) + '\n');
        return 0;
      }
      process.stdout.write(header(`Graph: ${node.node!.kind}:${node.node!.id}`));
      process.stdout.write(kv('title', node.node!.title) + '\n');
      if (node.node!.summary) process.stdout.write(kv('summary', node.node!.summary) + '\n');
      process.stdout.write(kv('source', node.node!.source) + '\n');
      if (node.outgoing.length) {
        process.stdout.write('\nOutgoing:\n');
        for (const e of node.outgoing) {
          process.stdout.write(`  → ${e.to.padEnd(40)} (${e.relation}) ${e.why}\n`);
        }
      }
      if (node.incoming.length) {
        process.stdout.write('\nIncoming:\n');
        for (const e of node.incoming) {
          process.stdout.write(`  ← ${e.from.padEnd(40)} (${e.relation}) ${e.why}\n`);
        }
      }
      return 0;
    }

    // Whole graph summary.
    const nodes = typeFlag
      ? graph.nodes.filter((n) => n.kind === typeFlag)
      : graph.nodes;
    if (formatFlag === 'dot' || formatFlag === 'mermaid') {
      const filteredGraph: IKnowledgeGraph = typeFlag
        ? {
            ...graph,
            nodes,
            edges: graph.edges.filter((e) => {
              const fromNode = graph.nodes.find((n) => n.id === e.from);
              const toNode = graph.nodes.find((n) => n.id === e.to);
              return fromNode?.kind === typeFlag || toNode?.kind === typeFlag;
            }),
          }
        : graph;
      const body = formatFlag === 'dot' ? renderDotGraph(filteredGraph) : renderMermaidGraph(filteredGraph);
      if (outputFlag) {
        writeOutput(args, outputFlag, body);
        return 0;
      }
      process.stdout.write(body);
      return 0;
    }
    if (formatFlag === 'json' || flagBool(args, 'json')) {
      process.stdout.write(asJson({ nodes, edges: graph.edges }) + '\n');
      return 0;
    }
    process.stdout.write(header('Knowledge graph'));
    process.stdout.write(kv('nodes', String(graph.nodes.length)) + '\n');
    process.stdout.write(kv('edges', String(graph.edges.length)) + '\n');
    if (!typeFlag) {
      const byKind = new Map<GraphNodeKind, number>();
      for (const n of graph.nodes) byKind.set(n.kind, (byKind.get(n.kind) ?? 0) + 1);
      process.stdout.write('\nNodes by kind:\n');
      for (const k of KNOWN_KINDS) {
        process.stdout.write(`  ${k.padEnd(10)} ${byKind.get(k) ?? 0}\n`);
      }
    } else {
      process.stdout.write(`\n${typeFlag} nodes:\n`);
      for (const n of nodes.slice(0, 30)) {
        process.stdout.write(`  ${n.id.padEnd(30)} ${n.title}\n`);
      }
      if (nodes.length > 30) {
        process.stdout.write(`  … (${nodes.length - 30} more)\n`);
      }
    }
    return 0;
  },
};

function escapeDot(value: string): string {
  return value.replace(/"/g, '\\"');
}

function renderDotGraph(graph: IKnowledgeGraph): string {
  const lines: string[] = [];
  lines.push('digraph SharkCraftKnowledge {');
  lines.push('  rankdir=LR;');
  lines.push('  node [shape=box, style="rounded,filled", fillcolor="#f5f5fa", fontname="Helvetica"];');
  for (const n of graph.nodes) {
    lines.push(
      `  "${n.kind}:${n.id}" [label="${escapeDot(n.kind + ': ' + n.id)}\\n${escapeDot(n.title)}"];`,
    );
  }
  for (const e of graph.edges) {
    lines.push(
      `  "${e.from}" -> "${e.to}" [label="${escapeDot(e.relation)}"];`,
    );
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}

function renderMermaidGraph(graph: IKnowledgeGraph): string {
  const lines: string[] = [];
  lines.push('graph LR');
  for (const n of graph.nodes) {
    lines.push(`  ${mermaidId(n.kind, n.id)}["${n.kind}:${n.id}"]`);
  }
  for (const e of graph.edges) {
    const fromNode = graph.nodes.find((n) => n.id === e.from);
    const toNode = graph.nodes.find((n) => n.id === e.to);
    if (!fromNode || !toNode) continue;
    lines.push(
      `  ${mermaidId(fromNode.kind, fromNode.id)} -->|${escapeMermaid(e.relation)}| ${mermaidId(toNode.kind, toNode.id)}`,
    );
  }
  return lines.join('\n') + '\n';
}

function mermaidId(kind: string, id: string): string {
  return (kind + '_' + id).replace(/[^a-zA-Z0-9_]/g, '_');
}

function escapeMermaid(value: string): string {
  return value.replace(/\|/g, '/');
}

interface IGraphNodeView {
  node: { id: string; kind: string; title: string } | null;
  outgoing: readonly { to: string; relation: string; why: string }[];
  incoming: readonly { from: string; relation: string; why: string }[];
}

function renderDotForNode(node: IGraphNodeView): string {
  const lines: string[] = [];
  lines.push('digraph SharkCraftNode {');
  lines.push('  rankdir=LR;');
  lines.push('  node [shape=box, style="rounded,filled", fillcolor="#f5f5fa", fontname="Helvetica"];');
  if (node.node) {
    lines.push(
      `  "${node.node.kind}:${node.node.id}" [label="${escapeDot(node.node.kind + ': ' + node.node.id)}\\n${escapeDot(node.node.title)}", fillcolor="#dde7ff"];`,
    );
  }
  for (const e of node.outgoing) {
    lines.push(`  "${node.node?.kind ?? ''}:${node.node?.id ?? ''}" -> "${e.to}" [label="${escapeDot(e.relation)}"];`);
  }
  for (const e of node.incoming) {
    lines.push(`  "${e.from}" -> "${node.node?.kind ?? ''}:${node.node?.id ?? ''}" [label="${escapeDot(e.relation)}"];`);
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}

function renderMermaidForNode(node: IGraphNodeView): string {
  const lines: string[] = [];
  lines.push('graph LR');
  if (node.node) {
    lines.push(`  ${mermaidId(node.node.kind, node.node.id)}["${node.node.kind}:${node.node.id}"]`);
  }
  for (const e of node.outgoing) {
    lines.push(
      `  ${mermaidId(node.node?.kind ?? '', node.node?.id ?? '')} -->|${escapeMermaid(e.relation)}| ${mermaidId('node', e.to)}`,
    );
  }
  for (const e of node.incoming) {
    lines.push(
      `  ${mermaidId('node', e.from)} -->|${escapeMermaid(e.relation)}| ${mermaidId(node.node?.kind ?? '', node.node?.id ?? '')}`,
    );
  }
  return lines.join('\n') + '\n';
}

function exportGraph(
  args: ParsedArgs,
  graph: IKnowledgeGraph,
  format: 'dot' | 'mermaid' | 'json',
  output: string,
): number {
  const body =
    format === 'dot'
      ? renderDotGraph(graph)
      : format === 'mermaid'
        ? renderMermaidGraph(graph)
        : JSON.stringify({ nodes: graph.nodes, edges: graph.edges }, null, 2) + '\n';
  writeOutput(args, output, body);
  return 0;
}

function writeOutput(args: ParsedArgs, output: string, body: string): void {
  const cwd = resolveCwd(args);
  const full = nodePath.isAbsolute(output) ? output : nodePath.resolve(cwd, output);
  mkdirSync(nodePath.dirname(full), { recursive: true });
  writeFileSync(full, body, 'utf8');
  process.stdout.write(`Wrote ${body.length} bytes to ${full}\n`);
}
