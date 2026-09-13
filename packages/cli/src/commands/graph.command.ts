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
import { nearest } from '../dispatch/closest-match.ts';
import { isVerbShaped } from '../dispatch/guard-invocation.ts';
import { PositionalMode } from '../dispatch/positional-mode.ts';
import type { ISubverbSpec } from '../dispatch/subverb-spec.ts';
import { usageExitFor } from '../exit-codes.ts';
import { asJson, header, kv } from '../output/format-output.ts';

/**
 * The flags the code-intelligence subverbs accept — the UNION of every flag
 * any of them reads, plus the global / meta flags, so a real flag is never
 * false-rejected (a25 §2.1). Declared as each code subverb's `flags`
 * (`GRAPH_SUBVERBS`): the dispatcher refuses any other flag BEFORE the subverb
 * runs, exiting `usageExitFor` — 3 on the verdict verb `graph cycles`, 2
 * elsewhere. (Round 11 moved this out of an inline guard in `run`.)
 */
const CODE_GRAPH_ALLOWED_FLAGS: ReadonlySet<string> = new Set([
  // code-subverb flags (union across index/status/search/context/impact/path/
  // hubs/callers/importers/cycles/unresolved/deps)
  'changed',
  'compact',
  'depth',
  'full',
  'has-unresolved-imports',
  'include-type-edges',
  'json',
  'kind',
  'limit',
  'max-depth',
  'min-size',
  'mode',
  'no-bridge',
  'no-framework',
  'no-refresh',
  'path',
  'since',
  'table',
  // --watch loop (graph index --watch)
  'watch',
  'paths',
  'debounce',
  'once',
  // global / meta flags that reach any verb
  'cwd',
  'strict',
  'help',
  'h',
  'no-color',
  'color',
]);
import {
  runGraphCallers,
  runGraphContext,
  runGraphCycles,
  runGraphDeps,
  runGraphHubs,
  runGraphImpact,
  runGraphImporters,
  runGraphIndex,
  runGraphPath,
  runGraphSearch,
  runGraphStatus,
  runGraphUnresolved,
} from './graph-code-subverbs.ts';

function codeGraphSubverb(
  name: string,
  description: string,
  usage: string,
  positionals?: PositionalMode,
): ISubverbSpec {
  return {
    name,
    description,
    usage,
    flags: CODE_GRAPH_ALLOWED_FLAGS,
    ...(positionals !== undefined ? { positionals } : {}),
  };
}

/**
 * Every subverb `graph` dispatches from `positional[0]` — the code-intelligence
 * family (each with the code-graph flag set) plus the knowledge-graph `why` /
 * `export` / `imports`. Any other token is an asset-graph node id (Free).
 * Declared so `help graph importers` prints real usage and the command index
 * lists them (they have no catalog rows of their own).
 */
const GRAPH_SUBVERBS: readonly ISubverbSpec[] = [
  codeGraphSubverb(
    'index',
    'Build or refresh the code graph (`--changed` for incremental; `--watch` keeps it fresh).',
    'shrk graph index [--changed] [--since <ref>] [--full] [--watch [--paths a,b] [--debounce N] [--once]] [--json]',
  ),
  codeGraphSubverb('status', 'Code-graph freshness, counts, and the unresolved-import summary.', 'shrk graph status [--json]'),
  codeGraphSubverb(
    'search',
    'Find files / symbols / packages in the code graph.',
    'shrk graph search <query> [--kind file|symbol|package] [--limit N] [--json]',
    PositionalMode.Free,
  ),
  codeGraphSubverb(
    'context',
    'Inspect one file or symbol with bridge enrichment.',
    'shrk graph context <fileOrSymbol> [--depth N] [--limit N|0] [--no-bridge] [--no-framework] [--json]',
    PositionalMode.Free,
  ),
  codeGraphSubverb(
    'impact',
    'The reverse dependent closure of a file or symbol.',
    'shrk graph impact <fileOrSymbol> [--max-depth N] [--limit N|0] [--full] [--json]',
    PositionalMode.Free,
  ),
  codeGraphSubverb(
    'path',
    'Is code A wired to code B? The shortest import / call path.',
    'shrk graph path <from> <to> [--max-depth N] [--no-refresh] [--json]',
    PositionalMode.Free,
  ),
  codeGraphSubverb(
    'hubs',
    'The most-depended-on symbols / files (load-bearing code; scope it to a subsystem).',
    'shrk graph hubs [--limit N] [--path <dir>] [--mode <mode>] [--json]',
  ),
  codeGraphSubverb(
    'callers',
    'The files that call / reference a symbol, as path:line.',
    'shrk graph callers <symbol> [--mode call|reference] [--limit N|0] [--no-refresh] [--json]',
    PositionalMode.Free,
  ),
  codeGraphSubverb(
    'importers',
    'Every module that imports a module — alias / type-only / re-export aware.',
    'shrk graph importers <file|module-specifier> [--mode import|reexport|type-only|all] [--limit N|0] [--no-refresh] [--json]',
    PositionalMode.Free,
  ),
  codeGraphSubverb(
    'cycles',
    'The import cycles (type-only edges excluded unless --include-type-edges).',
    'shrk graph cycles [--include-type-edges] [--min-size N] [--limit N] [--json]',
  ),
  codeGraphSubverb('unresolved', 'The unresolved imports, grouped by file.', 'shrk graph unresolved [--json]'),
  codeGraphSubverb(
    'deps',
    'Inbound / outbound package dependencies.',
    'shrk graph deps <package-name> [--json]',
    PositionalMode.Free,
  ),
  {
    name: 'why',
    description: 'The shortest-path explanation between two knowledge-graph nodes.',
    usage: 'shrk graph why <fromId> <toId> [--json]',
    positionals: PositionalMode.Free,
  },
  {
    name: 'export',
    description: 'Write the knowledge graph as dot / mermaid / json.',
    usage: 'shrk graph export --format dot|mermaid|json --output <file>',
  },
  {
    name: 'imports',
    description: 'Import-graph analysis: cycles, fan-in / fan-out, orphans.',
    usage: 'shrk graph imports [--cycles] [--fan-in] [--fan-out] [--orphans] [--json]',
  },
];

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
  // Free: any token that names no subverb is an asset-graph node id.
  positionals: PositionalMode.Free,
  subverbs: GRAPH_SUBVERBS,
  description:
    'Show the SharkCraft knowledge graph and the code-intelligence graph surface. Use `shrk graph <id>` for asset-graph nodes and `shrk graph index|status|search|context|impact|path|hubs|callers|importers|cycles|unresolved|deps|why|export` for code-graph workflows.',
  usage:
    'shrk [--cwd <dir>] graph [<id>] [--type <kind>] [--format text|json|dot|mermaid] [--output <file>] [--json]\n' +
    'shrk graph index|status|search|context|impact|path|hubs|callers|importers|cycles|unresolved|deps|why|export ...\n' +
    'shrk graph path <from> <to>   — is code A wired to code B? (shortest import/call path)\n' +
    'shrk graph hubs [--limit N] [--path <dir>]   — most-depended-on symbols/files (load-bearing code; scope to a subsystem)',
  async run(args: ParsedArgs): Promise<number> {
    // Code-intelligence subverbs (R65) don't need the knowledge graph —
    // dispatch them before the expensive inspection so they stay fast. Their
    // flags were already judged by the dispatcher (GRAPH_SUBVERBS `flags`).
    const earlySub = args.positional[0];
    if (earlySub === 'index') return runGraphIndex(args);
    if (earlySub === 'status') return runGraphStatus(args);
    if (earlySub === 'search') return runGraphSearch(args);
    if (earlySub === 'context') return runGraphContext(args);
    if (earlySub === 'impact') return runGraphImpact(args);
    if (earlySub === 'path') return runGraphPath(args);
    if (earlySub === 'hubs') return runGraphHubs(args);
    if (earlySub === 'callers') return runGraphCallers(args);
    if (earlySub === 'importers') return runGraphImporters(args);
    if (earlySub === 'cycles') return runGraphCycles(args);
    if (earlySub === 'unresolved') return runGraphUnresolved(args);
    if (earlySub === 'deps') return runGraphDeps({ ...args, positional: args.positional.slice(1) });

    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const graph = buildKnowledgeGraph(inspection);
    const sub = args.positional[0];
    const typeFlag = flagString(args, 'type') as GraphNodeKind | undefined;
    // A typo'd `--type` would otherwise silently match zero nodes and return an
    // empty summary / "no node" at exit 0/1. Reject loudly with the valid list.
    if (typeFlag && !KNOWN_KINDS.includes(typeFlag)) {
      process.stderr.write(
        `Unknown --type ${typeFlag}. Valid: ${KNOWN_KINDS.join(', ')}\n`,
      );
      return 2;
    }
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
        // A verb-shaped id one typo from a graph subverb (`graph statsu`,
        // `graph importrs foo`) is a mistyped verb, not a missing node: name
        // the closest subverb and exit as the usage error it is — never the
        // failure verdict 1 of an absent node.
        const sub = isVerbShaped(id) ? nearest(id, GRAPH_SUBVERBS.map((s) => s.name)) : undefined;
        if (sub !== undefined) {
          process.stderr.write(
            `\`shrk graph\` has no \`${id}\` subcommand, and no graph node is named "${id}".\n` +
              `  Did you mean \`shrk graph ${sub}\`?\n` +
              '  Run `shrk help graph` for usage.\n',
          );
          return usageExitFor('graph');
        }
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
