import type { IEdge } from '../schema/edge.ts';
import { EdgeKind } from '../schema/edge-kind.ts';
import type { IGraphSnapshot } from '../schema/graph-snapshot.ts';
import type { INode } from '../schema/node.ts';
import { NodeKind } from '../schema/node-kind.ts';
import { GraphStore } from '../store/graph-store.ts';
import { findFileCycles, type IFileCycle } from './cycle-detection.ts';

export interface IGraphStatus {
  exists: boolean;
  state: 'fresh' | 'stale' | 'missing' | 'corrupt';
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  lastIndexedAt?: string;
  digestOk?: boolean;
}

export interface IGraphNeighbours {
  node: INode;
  /** Outgoing edges (this → other). */
  out: readonly { edge: IEdge; target: INode | { id: string; resolved: false } }[];
  /** Incoming edges (other → this). */
  in: readonly { edge: IEdge; source: INode | { id: string; resolved: false } }[];
}

export interface IFindSymbolOptions {
  /** Filter by symbol package. */
  package?: string;
  /** Hard cap on returned matches. Default 50. */
  limit?: number;
  /** Exact match required (no case-insensitive / prefix matching). */
  exact?: boolean;
}

/**
 * Read-only query layer over an in-memory graph snapshot.
 *
 * The CLI/MCP layer constructs one instance per request from a freshly
 * loaded snapshot. The query API never writes; only the indexer does.
 */
export class GraphQueryApi {
  private readonly fileByPath: ReadonlyMap<string, INode>;
  private readonly symbolByName: ReadonlyMap<string, readonly INode[]>;
  private readonly outByFrom: ReadonlyMap<string, readonly IEdge[]>;
  private readonly inByTo: ReadonlyMap<string, readonly IEdge[]>;

  constructor(private readonly snap: IGraphSnapshot) {
    const fileByPath = new Map<string, INode>();
    const symbolByName = new Map<string, INode[]>();
    for (const n of snap.nodes.values()) {
      if (n.kind === NodeKind.File && n.path) {
        fileByPath.set(n.path, n);
      } else if (n.kind === NodeKind.Symbol) {
        const arr = symbolByName.get(n.label);
        if (arr) arr.push(n);
        else symbolByName.set(n.label, [n]);
      }
    }
    const outByFrom = new Map<string, IEdge[]>();
    const inByTo = new Map<string, IEdge[]>();
    for (const e of snap.edges.values()) {
      const ofrom = outByFrom.get(e.from);
      if (ofrom) ofrom.push(e);
      else outByFrom.set(e.from, [e]);
      const ito = inByTo.get(e.to);
      if (ito) ito.push(e);
      else inByTo.set(e.to, [e]);
    }
    this.fileByPath = fileByPath;
    this.symbolByName = symbolByName;
    this.outByFrom = outByFrom;
    this.inByTo = inByTo;
  }

  /** Load a snapshot from disk and construct the query API. */
  static fromStore(projectRoot: string): GraphQueryApi {
    const store = new GraphStore(projectRoot);
    return new GraphQueryApi(store.loadSnapshot());
  }

  status(): IGraphStatus {
    const m = this.snap.manifest;
    return {
      exists: true,
      state: 'fresh',
      fileCount: m.filesIndexed,
      nodeCount: this.snap.nodes.size,
      edgeCount: this.snap.edges.size,
      lastIndexedAt: m.lastIndexedAt,
    };
  }

  findFile(path: string): INode | undefined {
    return this.fileByPath.get(path);
  }

  /** Iterate every file node in the snapshot. Cheap; in-memory walk. */
  *allFiles(): IterableIterator<INode> {
    for (const n of this.fileByPath.values()) yield n;
  }

  /**
   * Files that have at least one `unresolved:<spec>` import edge.
   * Useful for `shrk graph search --kind file --has-unresolved-imports`.
   * Iterates outgoing edges per file; cheap in-memory walk.
   */
  filesWithUnresolvedImports(): readonly INode[] {
    const out: INode[] = [];
    for (const node of this.fileByPath.values()) {
      const edges = this.outByFrom.get(node.id) ?? [];
      for (const e of edges) {
        if (e.kind !== EdgeKind.ImportsFile) continue;
        if (!e.to.startsWith('unresolved:')) continue;
        out.push(node);
        break;
      }
    }
    return out;
  }

  /** Iterate every package node in the snapshot. */
  *allPackages(): IterableIterator<INode> {
    for (const n of this.snap.nodes.values()) {
      if (n.kind === NodeKind.Package) yield n;
    }
  }

  findSymbol(name: string, opts: IFindSymbolOptions = {}): readonly INode[] {
    const limit = opts.limit ?? 50;
    if (opts.exact !== false) {
      const exact = this.symbolByName.get(name) ?? [];
      return filterByPackage(exact, opts.package).slice(0, limit);
    }
    const lower = name.toLowerCase();
    const out: INode[] = [];
    for (const [k, list] of this.symbolByName) {
      if (!k.toLowerCase().includes(lower)) continue;
      for (const n of list) out.push(n);
      if (out.length >= limit * 2) break;
    }
    return filterByPackage(out, opts.package).slice(0, limit);
  }

  /** Files that import `nodeId` (directly). */
  importersOf(nodeId: string): readonly INode[] {
    const edges = this.inByTo.get(nodeId) ?? [];
    const out: INode[] = [];
    for (const e of edges) {
      if (e.kind !== EdgeKind.ImportsFile) continue;
      const n = this.snap.nodes.get(e.from);
      if (n) out.push(n);
    }
    return out;
  }

  /** Files imported by `nodeId` (directly). Resolves only File-kind targets. */
  importsFrom(nodeId: string): readonly INode[] {
    const edges = this.outByFrom.get(nodeId) ?? [];
    const out: INode[] = [];
    for (const e of edges) {
      if (e.kind !== EdgeKind.ImportsFile) continue;
      const n = this.snap.nodes.get(e.to);
      if (n) out.push(n);
    }
    return out;
  }

  /** Symbols declared by a given file. */
  symbolsIn(fileNodeId: string): readonly INode[] {
    const edges = this.outByFrom.get(fileNodeId) ?? [];
    const out: INode[] = [];
    for (const e of edges) {
      if (e.kind !== EdgeKind.DeclaresSymbol) continue;
      const n = this.snap.nodes.get(e.to);
      if (n) out.push(n);
    }
    return out;
  }

  /** Files that *call* the given symbol (Wave 3 — file-level precision). */
  callersOf(symbolNodeId: string): readonly INode[] {
    const edges = this.inByTo.get(symbolNodeId) ?? [];
    const out: INode[] = [];
    for (const e of edges) {
      if (e.kind !== EdgeKind.CallsSymbol) continue;
      const n = this.snap.nodes.get(e.from);
      if (n) out.push(n);
    }
    return out;
  }

  /** Files that *reference* the given symbol (any use, including calls). */
  referencesOf(symbolNodeId: string): readonly INode[] {
    const edges = this.inByTo.get(symbolNodeId) ?? [];
    const out: INode[] = [];
    const seen = new Set<string>();
    for (const e of edges) {
      if (e.kind !== EdgeKind.ReferencesSymbol && e.kind !== EdgeKind.CallsSymbol) continue;
      if (seen.has(e.from)) continue;
      seen.add(e.from);
      const n = this.snap.nodes.get(e.from);
      if (n) out.push(n);
    }
    return out;
  }

  /** Packages that this package depends on (PackageDependsOn). */
  packageDeps(packageName: string): readonly INode[] {
    const edges = this.outByFrom.get(`package:${packageName}`) ?? [];
    const out: INode[] = [];
    for (const e of edges) {
      if (e.kind !== EdgeKind.PackageDependsOn) continue;
      const n = this.snap.nodes.get(e.to);
      if (n) out.push(n);
    }
    return out;
  }

  /** Packages that depend on this package (reverse PackageDependsOn). */
  packageDependents(packageName: string): readonly INode[] {
    const edges = this.inByTo.get(`package:${packageName}`) ?? [];
    const out: INode[] = [];
    for (const e of edges) {
      if (e.kind !== EdgeKind.PackageDependsOn) continue;
      const n = this.snap.nodes.get(e.from);
      if (n) out.push(n);
    }
    return out;
  }

  /**
   * Every import cycle in the snapshot (SCC ≥ 2). Recomputes from the
   * in-memory snapshot — file paths are filled in from the snapshot's
   * file nodes. Sorted by size descending then id ascending so callers
   * get a stable "worst first" ordering. Roadmap §3.1 long-promised
   * this method on the query API; backed by `findFileCycles` so the
   * indexer's manifest counts stay consistent with what callers see.
   */
  cycles(): readonly IFileCycle[] {
    const pathById = new Map<string, string>();
    for (const [id, n] of this.snap.nodes) {
      if (n.kind === NodeKind.File && n.path) pathById.set(id, n.path);
    }
    return findFileCycles(
      [...this.snap.nodes.values()],
      [...this.snap.edges.values()],
      pathById,
    );
  }

  /** 1-hop neighbours of a node, both in + out. */
  neighbours(nodeId: string): IGraphNeighbours | undefined {
    const node = this.snap.nodes.get(nodeId);
    if (!node) return undefined;
    const outEdges = this.outByFrom.get(nodeId) ?? [];
    const inEdges = this.inByTo.get(nodeId) ?? [];
    return {
      node,
      out: outEdges.map((edge) => {
        const target = this.snap.nodes.get(edge.to);
        return { edge, target: target ?? { id: edge.to, resolved: false } };
      }),
      in: inEdges.map((edge) => {
        const source = this.snap.nodes.get(edge.from);
        return { edge, source: source ?? { id: edge.from, resolved: false } };
      }),
    };
  }
}

function filterByPackage(list: readonly INode[], pkg?: string): INode[] {
  if (!pkg) return [...list];
  const prefix = pkg + '/';
  return list.filter((n) => {
    if (!n.path) return false;
    // Workspace packages live at `packages/<slug>/...`. Without a path-
    // alias map at query time, the cheap proxy is "path starts with the
    // package directory prefix". Caller passes the directory, not the
    // package name, for now.
    return n.path === pkg || n.path.startsWith(prefix);
  });
}
