import { statSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IEdge } from '../schema/edge.ts';
import { EdgeKind } from '../schema/edge-kind.ts';
import type { IGraphSnapshot } from '../schema/graph-snapshot.ts';
import type { INode } from '../schema/node.ts';
import { NodeKind } from '../schema/node-kind.ts';
import { GraphStore } from '../store/graph-store.ts';
import { fingerprintFile } from '../store/file-fingerprint.ts';
import { findFileCycles, type IFileCycle } from './cycle-detection.ts';

/** Read the representative source line stored on a reference/call edge. */
function edgeLine(e: IEdge): number | undefined {
  const v = e.data?.['line'];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

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

export interface IStaleResultFiles {
  /** Result files whose on-disk content changed since indexing (line numbers / membership may be stale). */
  modified: readonly string[];
  /** Result files that no longer exist on disk (should be dropped from results). */
  deleted: readonly string[];
}

export interface ICallSite {
  /** The file node that calls / references the symbol. */
  node: INode;
  /**
   * Representative source line of the use. The indexer de-dupes reference
   * edges by (target, kind), so this is the FIRST recorded call/reference
   * site in that file — enough for an agent to jump straight to, not an
   * exhaustive list of every occurrence.
   */
  line?: number;
}

/** A single hop along a directed code path: `from` uses `to` via `kind`. */
export interface IGraphPathHop {
  from: INode;
  to: INode;
  kind: EdgeKind;
  /** Representative source line of the use (call/reference edges carry one). */
  line?: number;
}

/** Result of a directed reachability query between two code nodes. */
export interface IGraphPath {
  /** True when a directed `from → … → to` path exists within the depth cap. */
  found: boolean;
  from?: INode;
  to?: INode;
  /** The shortest path, hop by hop. Empty when `from === to` or not found. */
  hops: readonly IGraphPathHop[];
  /** Nodes visited before answering — context for a "no path" result. */
  explored: number;
  /** Why the query could not run / find a path (endpoint missing, depth cap). */
  reason?: string;
}

/** A load-bearing node and how many distinct files depend on it. */
export interface IGraphHub {
  node: INode;
  /** Distinct dependents: referencing files for a symbol, importers for a file. */
  inDegree: number;
}

/** The most-depended-on code in the snapshot — what to change carefully. */
export interface IGraphHubs {
  /** Most-referenced symbols (functions / classes / types). */
  symbols: readonly IGraphHub[];
  /** Most-imported files. */
  files: readonly IGraphHub[];
}

/**
 * Forward "code uses code" edge kinds traversed by {@link GraphQueryApi.pathBetween}.
 * Structural source-level dependencies only — package-aggregate edges
 * (`belongs-to-package` / `package-depends-on`) and asset-bridge edges
 * (rules / framework) are deliberately excluded so a path is always a real
 * import/call/reference/heritage chain, not a routing through a package node.
 */
/**
 * Internal scan bound for honest match COUNTS in {@link GraphQueryApi.searchNodes}
 * — large enough that `total` is accurate for any realistic repo, bounded so a
 * pathological query can't walk forever.
 */
const SEARCH_TOTAL_SCAN_CAP = 100_000;

const CODE_PATH_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>([
  EdgeKind.ImportsFile,
  EdgeKind.CallsSymbol,
  EdgeKind.ReferencesSymbol,
  EdgeKind.DeclaresSymbol,
  EdgeKind.ReExportsSymbol,
  EdgeKind.ExtendsSymbol,
  EdgeKind.ImplementsSymbol,
]);

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

  /**
   * Load a snapshot from disk and construct the query API. Propagates the typed
   * corrupt-store error from {@link GraphStore.loadSnapshot} (one bad JSONL line
   * → a typed AppError, not a raw `JSON Parse error`) so callers can turn it into
   * a clean "rebuild the index" hint instead of crashing.
   */
  static fromStore(projectRoot: string): GraphQueryApi {
    const store = new GraphStore(projectRoot);
    return new GraphQueryApi(store.loadSnapshot());
  }

  /**
   * Search the graph by path / symbol name / package name, returning the
   * display-capped page AND the TRUE pre-slice match count so a caller can emit
   * an honest `total` + `truncated` flag (the old per-surface code reported the
   * post-cap length as the total, so 285 matches showed as `total: 20`). The
   * single source of truth shared by the CLI `graph search` and the MCP
   * `get_graph_search` tool, so the two never drift.
   *
   * `exact` suppresses the fuzzy file-substring fallback and forces exact symbol
   * lookup (default fuzzy). The full match set is counted with a generous
   * internal scan bound so `total` stays accurate for any realistic repo.
   */
  searchNodes(
    query: string,
    opts: { kind?: 'file' | 'symbol' | 'package'; limit?: number; exact?: boolean } = {},
  ): { matches: INode[]; total: number } {
    const { kind, exact = false } = opts;
    const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : 20;
    const all: INode[] = [];
    const seen = new Set<string>();
    const push = (n: INode): void => {
      if (seen.has(n.id)) return;
      seen.add(n.id);
      all.push(n);
    };
    if (!kind || kind === 'file') {
      const f = this.findFile(query);
      if (f) push(f);
      // Fuzzy fallback: substring match on path/basename so a bare `Foo` finds
      // `packages/x/Foo.ts` without the full path. Suppressed by `exact`.
      if (!exact) {
        const q = query.toLowerCase();
        for (const node of this.allFiles()) {
          const p = node.path?.toLowerCase() ?? '';
          const base = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
          if (base.includes(q) || p.includes(q)) push(node);
        }
      }
    }
    if (!kind || kind === 'symbol') {
      // Count-honest: collect ALL matches (large internal cap) so `total` is the
      // true match count, then slice for display below.
      for (const s of this.findSymbol(query, { exact, limit: SEARCH_TOTAL_SCAN_CAP })) push(s);
    }
    if (!kind || kind === 'package') {
      const pkg = this.snap.nodes.get(`package:${query}`);
      if (pkg && pkg.kind === NodeKind.Package) push(pkg);
    }
    return { matches: all.slice(0, limit), total: all.length };
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

  /**
   * Symbols that EXTEND or IMPLEMENT the given symbol — the precise "who
   * implements this interface / who subclasses this" answer that a generic
   * reference cannot give (a reference might be a call, a type annotation, or
   * a heritage clause; these are typed `extends-symbol`/`implements-symbol`
   * edges only). Returns the subtype symbol nodes.
   */
  subtypesOf(symbolNodeId: string): readonly INode[] {
    const edges = this.inByTo.get(symbolNodeId) ?? [];
    const out: INode[] = [];
    for (const e of edges) {
      if (e.kind !== EdgeKind.ExtendsSymbol && e.kind !== EdgeKind.ImplementsSymbol) continue;
      const n = this.snap.nodes.get(e.from);
      if (n) out.push(n);
    }
    return out;
  }

  /** Symbols the given symbol EXTENDS or IMPLEMENTS (its supertypes). */
  supertypesOf(symbolNodeId: string): readonly INode[] {
    const edges = this.outByFrom.get(symbolNodeId) ?? [];
    const out: INode[] = [];
    for (const e of edges) {
      if (e.kind !== EdgeKind.ExtendsSymbol && e.kind !== EdgeKind.ImplementsSymbol) continue;
      const n = this.snap.nodes.get(e.to);
      if (n) out.push(n);
    }
    return out;
  }

  /**
   * Like {@link callersOf}, but keeps the call-site line carried on each
   * edge so a caller can render `path:line` (jump-straight-to-source)
   * instead of just the file path — the difference between "grep, then grep
   * again inside each file" and a direct hit.
   */
  callerSitesOf(symbolNodeId: string): readonly ICallSite[] {
    const edges = this.inByTo.get(symbolNodeId) ?? [];
    const out: ICallSite[] = [];
    for (const e of edges) {
      if (e.kind !== EdgeKind.CallsSymbol) continue;
      const n = this.snap.nodes.get(e.from);
      if (n) out.push({ node: n, line: edgeLine(e) });
    }
    return out;
  }

  /** Like {@link referencesOf}, but keeps the representative use-site line. */
  referenceSitesOf(symbolNodeId: string): readonly ICallSite[] {
    const edges = this.inByTo.get(symbolNodeId) ?? [];
    const out: ICallSite[] = [];
    const seen = new Set<string>();
    for (const e of edges) {
      if (e.kind !== EdgeKind.ReferencesSymbol && e.kind !== EdgeKind.CallsSymbol) continue;
      if (seen.has(e.from)) continue;
      seen.add(e.from);
      const n = this.snap.nodes.get(e.from);
      if (n) out.push({ node: n, line: edgeLine(e) });
    }
    return out;
  }

  /**
   * Targeted, cheap staleness check over a handful of RESULT file paths (the
   * declaring file + caller/dependent files of a query) — NOT a full tree
   * walk. For each project-relative path that the index knows about: stat it
   * (mtime+size gate, sha1 only on mismatch) and classify as `modified`
   * (content changed → results may be wrong: stale lines / a removed caller
   * still listed) or `deleted` (gone from disk → drop it). Lets a query flag
   * or prune a silently-stale answer for a file the agent just edited without
   * paying for a whole-repo freshness walk. `cwd` is passed explicitly: the
   * snapshot's index-time absolute root is wrong if the repo moved.
   */
  staleFilesAmong(cwd: string, paths: readonly string[]): IStaleResultFiles {
    const modified: string[] = [];
    const deleted: string[] = [];
    const seen = new Set<string>();
    for (const rel of paths) {
      if (seen.has(rel)) continue;
      seen.add(rel);
      const fp = this.snap.files.get(rel);
      if (!fp) continue; // not an indexed file — nothing to compare against
      const abs = nodePath.isAbsolute(rel) ? rel : nodePath.join(cwd, rel);
      let st;
      try {
        st = statSync(abs);
      } catch {
        deleted.push(rel);
        continue;
      }
      if (!st.isFile()) {
        deleted.push(rel);
        continue;
      }
      if (Math.floor(st.mtimeMs) === fp.mtime && st.size === fp.sizeBytes) continue; // fresh
      if (fingerprintFile(abs, cwd).sha1 !== fp.sha1) modified.push(rel);
    }
    modified.sort((a, b) => a.localeCompare(b));
    deleted.sort((a, b) => a.localeCompare(b));
    return { modified, deleted };
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

  /**
   * Shortest directed code path from `fromId` to `toId` over the
   * "code uses code" edges (imports / calls / references / declares /
   * re-exports / extends / implements). Answers "is A actually wired to B?"
   * deterministically: a found path lists every hop with its edge kind (and
   * call-site line where the edge carries one) so a caller sees HOW they are
   * wired — a chain of `imports-file` hops reads very differently from a
   * `calls-symbol` one. Breadth-first, so the returned path is minimal-hop;
   * `explored` reports how many nodes were visited so a "no path" answer is
   * honestly bounded rather than read as "definitely unrelated".
   */
  pathBetween(fromId: string, toId: string, opts: { maxDepth?: number } = {}): IGraphPath {
    const maxDepth = opts.maxDepth && opts.maxDepth > 0 ? opts.maxDepth : 16;
    const from = this.snap.nodes.get(fromId);
    const to = this.snap.nodes.get(toId);
    if (!from || !to) {
      return {
        found: false,
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        hops: [],
        explored: 0,
        reason: !from && !to
          ? 'neither endpoint is in the graph'
          : !from
            ? 'source node is not in the graph'
            : 'target node is not in the graph',
      };
    }
    if (fromId === toId) return { found: true, from, to, hops: [], explored: 1 };
    // BFS. `parent` maps a discovered node id to the edge that first reached it.
    const parent = new Map<string, IEdge>();
    const depth = new Map<string, number>([[fromId, 0]]);
    const queue: string[] = [fromId];
    let head = 0;
    let explored = 0;
    while (head < queue.length) {
      const cur = queue[head++]!;
      explored++;
      const d = depth.get(cur)!;
      if (d >= maxDepth) continue;
      for (const e of this.outByFrom.get(cur) ?? []) {
        if (!CODE_PATH_EDGE_KINDS.has(e.kind)) continue;
        if (e.to === cur || e.to === fromId || parent.has(e.to)) continue;
        parent.set(e.to, e);
        depth.set(e.to, d + 1);
        if (e.to === toId) {
          return { found: true, from, to, hops: this.reconstructPath(parent, fromId, toId), explored };
        }
        queue.push(e.to);
      }
    }
    return { found: false, from, to, hops: [], explored, reason: `no code path within ${maxDepth} hops` };
  }

  /** Walk the BFS `parent` map back from `toId` to `fromId` into ordered hops. */
  private reconstructPath(parent: ReadonlyMap<string, IEdge>, fromId: string, toId: string): IGraphPathHop[] {
    const chain: IEdge[] = [];
    let cur = toId;
    while (cur !== fromId) {
      const e = parent.get(cur);
      if (!e) break;
      chain.push(e);
      cur = e.from;
    }
    chain.reverse();
    const hops: IGraphPathHop[] = [];
    for (const e of chain) {
      const f = this.snap.nodes.get(e.from);
      const t = this.snap.nodes.get(e.to);
      if (!f || !t) continue;
      const line = edgeLine(e);
      hops.push({ from: f, to: t, kind: e.kind, ...(line !== undefined ? { line } : {}) });
    }
    return hops;
  }

  /**
   * The most-depended-on code in the snapshot: symbols ranked by how many
   * distinct files reference/call them and files ranked by how many distinct
   * files import them. This is the "load-bearing code" view — the surface an
   * agent should change most carefully and a human should understand first.
   * In-degree counts DISTINCT dependent files (a file that calls a symbol
   * ten times counts once), so the rank reflects blast radius, not call volume.
   */
  /**
   * The DIRECT dependents of a node — what breaks if you change it, one hop out.
   * Kind-aware, because the edge that carries "depends on" differs by kind:
   *   - Symbol: the files that reference/call it, PLUS the files declaring its
   *     subtypes (a class that `import type`s an interface has no value-reference
   *     edge, so subtypes must be added explicitly or implementers are missed).
   *     Falls back to the importers of its declaring file when nothing references
   *     the symbol directly.
   *   - File: its importers (`imports-file`).
   *   - Package: the packages that depend on it.
   * The shared building block for impact reverse-closures (CLI + MCP) — keep this
   * the ONE source of truth so the two surfaces never disagree on a symbol's
   * blast radius (they once did: an importers-only closure returned NOTHING for a
   * symbol, a confidently-wrong "nothing breaks").
   */
  directDependentsOf(anchor: INode): readonly INode[] {
    if (anchor.kind === NodeKind.Symbol) {
      const owner = this.declaringFileOf(anchor.id);
      const out = new Map<string, INode>();
      for (const n of this.referencesOf(anchor.id)) {
        if (n.kind === NodeKind.File && n.id !== owner?.id) out.set(n.id, n);
      }
      for (const n of this.callersOf(anchor.id)) {
        if (n.kind === NodeKind.File && n.id !== owner?.id) out.set(n.id, n);
      }
      for (const s of this.subtypesOf(anchor.id)) {
        if (!s.path) continue;
        const fileNode = this.fileByPath.get(s.path);
        if (fileNode && fileNode.id !== owner?.id) out.set(fileNode.id, fileNode);
      }
      if (out.size > 0) return [...out.values()];
      return owner ? [...this.importersOf(owner.id)] : [];
    }
    if (anchor.kind === NodeKind.Package) {
      return this.packageDependents(anchor.id.replace(/^package:/, ''));
    }
    return [...this.importersOf(anchor.id)];
  }

  /** The file that declares a symbol (the `declares-symbol` source), if known. */
  declaringFileOf(symbolId: string): INode | undefined {
    for (const e of this.inByTo.get(symbolId) ?? []) {
      if (e.kind !== EdgeKind.DeclaresSymbol) continue;
      const n = this.snap.nodes.get(e.from);
      if (n && n.kind === NodeKind.File) return n;
    }
    return undefined;
  }

  topHubs(limit = 10, pathPrefix?: string): IGraphHubs {
    // Optional path scope: rank only the load-bearing code WITHIN a subsystem
    // (e.g. `packages/inspector`) — the global hubs are dominated by the biggest
    // packages, but an agent working in one area wants that area's hubs. The
    // in-degree still counts ALL dependents (anyone in the repo), answering
    // "within this dir, what is most depended-on?".
    const prefix = pathPrefix ? pathPrefix.replace(/\\/g, '/').replace(/\/+$/, '') : undefined;
    const inScope = (path: string | undefined): boolean =>
      !prefix || (path !== undefined && (path === prefix || path.startsWith(prefix + '/')));
    const symbolDeps = new Map<string, Set<string>>();
    const fileDeps = new Map<string, Set<string>>();
    for (const [toId, edges] of this.inByTo) {
      const target = this.snap.nodes.get(toId);
      if (!target) continue;
      if (!inScope(target.path)) continue;
      if (target.kind === NodeKind.Symbol) {
        const set = new Set<string>();
        for (const e of edges) {
          if (e.kind === EdgeKind.ReferencesSymbol || e.kind === EdgeKind.CallsSymbol) {
            set.add(e.from); // reference/call edges originate on a file node
          } else if (e.kind === EdgeKind.ExtendsSymbol || e.kind === EdgeKind.ImplementsSymbol) {
            // Heritage edges originate on the SUBTYPE symbol — count its file so
            // an interface implemented only via `import type` (no reference edge)
            // still ranks as load-bearing, at the same file granularity.
            const sub = this.snap.nodes.get(e.from);
            set.add(sub?.path ? `file:${sub.path}` : e.from);
          }
        }
        if (set.size > 0) symbolDeps.set(toId, set);
      } else if (target.kind === NodeKind.File) {
        const set = new Set<string>();
        for (const e of edges) {
          if (e.kind === EdgeKind.ImportsFile) set.add(e.from);
        }
        if (set.size > 0) fileDeps.set(toId, set);
      }
    }
    const cap = Math.max(0, limit);
    const toHubs = (m: Map<string, Set<string>>): IGraphHub[] => {
      const arr: IGraphHub[] = [];
      for (const [id, set] of m) {
        const node = this.snap.nodes.get(id);
        if (node) arr.push({ node, inDegree: set.size });
      }
      arr.sort((a, b) => b.inDegree - a.inDegree || a.node.label.localeCompare(b.node.label) || a.node.id.localeCompare(b.node.id));
      return arr.slice(0, cap);
    };
    return { symbols: toHubs(symbolDeps), files: toHubs(fileDeps) };
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
