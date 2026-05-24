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
  FRAMEWORK_SCHEMA,
  type IFrameworkManifest,
  type IFrameworkSnapshot,
} from '../schema/framework-schema.ts';

const NODES_DIR = 'nodes';
const EDGES_DIR = 'edges';
const META_FILE = 'meta.json';

/**
 * On-disk JSONL store for `@shrkcrft/framework-scanners`. Lives at
 * `<root>/.sharkcraft/framework/` alongside the code-graph and bridge
 * stores; merged in memory at query time.
 */
export class FrameworkStore {
  public readonly storeDir: string;

  constructor(private readonly projectRoot: string) {
    this.storeDir = nodePath.join(projectRoot, '.sharkcraft', 'framework');
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
    partial: Omit<IFrameworkManifest, 'schema' | 'digest'>,
  ): IFrameworkManifest {
    const nodesDir = nodePath.join(this.storeDir, NODES_DIR);
    const edgesDir = nodePath.join(this.storeDir, EDGES_DIR);
    if (existsSync(nodesDir)) rmSync(nodesDir, { recursive: true, force: true });
    if (existsSync(edgesDir)) rmSync(edgesDir, { recursive: true, force: true });
    mkdirSync(nodesDir, { recursive: true });
    mkdirSync(edgesDir, { recursive: true });

    // Bucket by framework name (one file per framework).
    const nodesByFramework = bucket(nodes, (n) => String((n.data?.['framework'] as string | undefined) ?? 'unknown'));
    const edgesByKind = bucket(edges, (e) => e.kind);
    for (const [framework, list] of Object.entries(nodesByFramework)) {
      list.sort((a, b) => a.id.localeCompare(b.id));
      writeJsonl(nodePath.join(nodesDir, `${framework}.jsonl`), list);
    }
    for (const [kind, list] of Object.entries(edgesByKind)) {
      list.sort((a, b) => a.id.localeCompare(b.id));
      writeJsonl(nodePath.join(edgesDir, `${kind}.jsonl`), list);
    }

    const digest = computeDigest(this.storeDir);
    const manifest: IFrameworkManifest = {
      schema: FRAMEWORK_SCHEMA,
      digest,
      ...partial,
    };
    writeFileSync(nodePath.join(this.storeDir, META_FILE), JSON.stringify(manifest, null, 2));
    return manifest;
  }

  loadSnapshot(): IFrameworkSnapshot {
    if (!this.exists()) {
      throw new Error(
        `framework store not found under ${this.storeDir}. Run 'shrk framework index'.`,
      );
    }
    const manifest = JSON.parse(
      readFileSync(nodePath.join(this.storeDir, META_FILE), 'utf8'),
    ) as IFrameworkManifest;
    if (manifest.schema !== FRAMEWORK_SCHEMA) {
      throw new Error(
        `framework schema mismatch: store=${manifest.schema}, expected=${FRAMEWORK_SCHEMA}.`,
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
