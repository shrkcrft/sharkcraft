import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as nodePath from 'node:path';
import type { IEdge, INode } from '@shrkcrft/graph';
import {
  RULE_GRAPH_SCHEMA,
  type IBridgeManifest,
  type IBridgeSnapshot,
} from '../schema/bridge-schema.ts';

const NODES_DIR = 'nodes';
const EDGES_DIR = 'edges';
const META_FILE = 'meta.json';

/**
 * On-disk store for bridge nodes + edges produced by `@shrkcrft/rule-graph`.
 *
 * Lives at `<root>/.sharkcraft/bridge/` so a `shrk graph index` rebuild of
 * the code graph does not stomp on bridge data. Both stores merge in
 * memory at query time.
 */
export class BridgeStore {
  public readonly storeDir: string;

  constructor(private readonly projectRoot: string) {
    this.storeDir = nodePath.join(projectRoot, '.sharkcraft', 'bridge');
  }

  exists(): boolean {
    return existsSync(nodePath.join(this.storeDir, META_FILE));
  }

  clear(): void {
    if (existsSync(this.storeDir)) {
      rmSync(this.storeDir, { recursive: true, force: true });
    }
  }

  writeSnapshot(
    nodes: readonly INode[],
    edges: readonly IEdge[],
    partial: Omit<IBridgeManifest, 'schema' | 'digest'>,
  ): IBridgeManifest {
    const nodesDir = nodePath.join(this.storeDir, NODES_DIR);
    const edgesDir = nodePath.join(this.storeDir, EDGES_DIR);
    if (existsSync(nodesDir)) rmSync(nodesDir, { recursive: true, force: true });
    if (existsSync(edgesDir)) rmSync(edgesDir, { recursive: true, force: true });
    mkdirSync(nodesDir, { recursive: true });
    mkdirSync(edgesDir, { recursive: true });

    const nodesByKind = bucket(nodes, (n) => n.kind);
    const edgesByKind = bucket(edges, (e) => e.kind);
    const nodeCounts: Record<string, number> = {};
    const edgeCounts: Record<string, number> = {};

    for (const [kind, list] of Object.entries(nodesByKind)) {
      list.sort((a, b) => a.id.localeCompare(b.id));
      writeJsonl(nodePath.join(nodesDir, `${kind}.jsonl`), list);
      nodeCounts[kind] = list.length;
    }
    for (const [kind, list] of Object.entries(edgesByKind)) {
      list.sort((a, b) => a.id.localeCompare(b.id));
      writeJsonl(nodePath.join(edgesDir, `${kind}.jsonl`), list);
      edgeCounts[kind] = list.length;
    }

    const digest = computeDigest(this.storeDir);
    const manifest: IBridgeManifest = {
      schema: RULE_GRAPH_SCHEMA,
      digest,
      ...partial,
      nodesByKind: nodeCounts,
      edgesByKind: edgeCounts,
    };
    writeFileSync(nodePath.join(this.storeDir, META_FILE), JSON.stringify(manifest, null, 2));
    return manifest;
  }

  loadSnapshot(): IBridgeSnapshot {
    if (!this.exists()) {
      throw new Error(
        `bridge store not found under ${this.storeDir}. Run 'shrk rule-graph index'.`,
      );
    }
    const manifest = JSON.parse(
      readFileSync(nodePath.join(this.storeDir, META_FILE), 'utf8'),
    ) as IBridgeManifest;
    if (manifest.schema !== RULE_GRAPH_SCHEMA) {
      throw new Error(
        `bridge schema mismatch: store=${manifest.schema}, expected=${RULE_GRAPH_SCHEMA}.`,
      );
    }
    const nodes = new Map<string, INode>();
    const nodesDir = nodePath.join(this.storeDir, NODES_DIR);
    if (existsSync(nodesDir)) {
      for (const fname of readdirSync(nodesDir)) {
        if (!fname.endsWith('.jsonl')) continue;
        for (const row of readJsonl<INode>(nodePath.join(nodesDir, fname))) {
          nodes.set(row.id, row);
        }
      }
    }
    const edges = new Map<string, IEdge>();
    const edgesDir = nodePath.join(this.storeDir, EDGES_DIR);
    if (existsSync(edgesDir)) {
      for (const fname of readdirSync(edgesDir)) {
        if (!fname.endsWith('.jsonl')) continue;
        for (const row of readJsonl<IEdge>(nodePath.join(edgesDir, fname))) {
          edges.set(row.id, row);
        }
      }
    }
    return { manifest, nodes, edges };
  }
}

function bucket<T>(list: readonly T[], key: (t: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of list) {
    const k = key(item);
    if (!out[k]) out[k] = [];
    out[k]!.push(item);
  }
  return out;
}

function writeJsonl(path: string, rows: readonly unknown[]): void {
  const body = rows.map((r) => JSON.stringify(r)).join('\n');
  writeFileSync(path, body.length > 0 ? body + '\n' : '');
}

function readJsonl<T>(path: string): T[] {
  const raw = readFileSync(path, 'utf8');
  if (!raw) return [];
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    out.push(JSON.parse(t) as T);
  }
  return out;
}

function computeDigest(storeDir: string): string {
  const hash = createHash('sha256');
  const targets: string[] = [];
  for (const sub of [NODES_DIR, EDGES_DIR]) {
    const dir = nodePath.join(storeDir, sub);
    if (!existsSync(dir)) continue;
    for (const fname of readdirSync(dir).sort()) {
      if (!fname.endsWith('.jsonl')) continue;
      targets.push(nodePath.join(dir, fname));
    }
  }
  targets.sort();
  for (const t of targets) {
    hash.update(nodePath.relative(storeDir, t));
    hash.update('\0');
    hash.update(readFileSync(t));
    hash.update('\0');
  }
  return hash.digest('hex');
}
