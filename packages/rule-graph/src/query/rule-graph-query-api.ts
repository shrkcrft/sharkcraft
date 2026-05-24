import {
  EdgeKind,
  GraphStore,
  type IEdge,
  type IGraphSnapshot,
  type INode,
} from '@shrkcrft/graph';
import { BridgeStore } from '../store/bridge-store.ts';
import type { IBridgeSnapshot } from '../schema/bridge-schema.ts';

export interface IBridgeEdgeHit {
  edge: IEdge;
  target: INode;
}

export interface IRuleGraphForFile {
  fileNodeId: string;
  path: string;
  rules: readonly IBridgeEdgeHit[];
  paths: readonly IBridgeEdgeHit[];
  templates: readonly IBridgeEdgeHit[];
}

/**
 * Query API over the merged code-graph + bridge-graph snapshots.
 *
 * Loaded once per request; reads are O(edges-touching-the-anchor) once
 * the inbound + outbound indexes are built.
 */
export class RuleGraphQueryApi {
  private readonly outByFrom: ReadonlyMap<string, readonly IEdge[]>;
  private readonly inByTo: ReadonlyMap<string, readonly IEdge[]>;
  private readonly mergedNodes: ReadonlyMap<string, INode>;
  private readonly fileByPath: ReadonlyMap<string, INode>;

  constructor(
    private readonly graphSnap: IGraphSnapshot,
    private readonly bridgeSnap: IBridgeSnapshot,
  ) {
    const out = new Map<string, IEdge[]>();
    const inn = new Map<string, IEdge[]>();
    for (const e of [...graphSnap.edges.values(), ...bridgeSnap.edges.values()]) {
      const o = out.get(e.from);
      if (o) o.push(e);
      else out.set(e.from, [e]);
      const i = inn.get(e.to);
      if (i) i.push(e);
      else inn.set(e.to, [e]);
    }
    const merged = new Map<string, INode>();
    for (const n of graphSnap.nodes.values()) merged.set(n.id, n);
    for (const n of bridgeSnap.nodes.values()) merged.set(n.id, n);
    const fileByPath = new Map<string, INode>();
    for (const n of graphSnap.nodes.values()) {
      if (n.path && n.kind === 'file') fileByPath.set(n.path, n);
    }
    this.outByFrom = out;
    this.inByTo = inn;
    this.mergedNodes = merged;
    this.fileByPath = fileByPath;
  }

  static fromStores(projectRoot: string): RuleGraphQueryApi {
    const g = new GraphStore(projectRoot).loadSnapshot();
    const b = new BridgeStore(projectRoot).loadSnapshot();
    return new RuleGraphQueryApi(g, b);
  }

  static missingDescription(projectRoot: string): string | undefined {
    const g = new GraphStore(projectRoot).exists();
    const b = new BridgeStore(projectRoot).exists();
    if (!g) return "Code-graph store missing. Run 'shrk graph index' then 'shrk rule-graph index'.";
    if (!b) return "Bridge store missing. Run 'shrk rule-graph index'.";
    return undefined;
  }

  /** Resolve a file path to its file node, or undefined. */
  findFile(path: string): INode | undefined {
    return this.fileByPath.get(path);
  }

  /** Everything that applies to a file: rules, paths, templates. */
  forFile(path: string): IRuleGraphForFile | undefined {
    const file = this.findFile(path);
    if (!file) return undefined;
    const out = this.outByFrom.get(file.id) ?? [];
    const rules: IBridgeEdgeHit[] = [];
    const paths: IBridgeEdgeHit[] = [];
    const templates: IBridgeEdgeHit[] = [];
    for (const e of out) {
      const target = this.mergedNodes.get(e.to);
      if (!target) continue;
      if (e.kind === EdgeKind.AppliesRule) rules.push({ edge: e, target });
      else if (e.kind === EdgeKind.MatchesPath) paths.push({ edge: e, target });
      else if (e.kind === EdgeKind.CoveredByTemplate) templates.push({ edge: e, target });
    }
    return { fileNodeId: file.id, path, rules, paths, templates };
  }

  /** Files that a given rule / path / template applies to. */
  filesFor(bridgeNodeId: string): readonly INode[] {
    const inn = this.inByTo.get(bridgeNodeId) ?? [];
    const out: INode[] = [];
    const seen = new Set<string>();
    for (const e of inn) {
      if (
        e.kind !== EdgeKind.AppliesRule &&
        e.kind !== EdgeKind.MatchesPath &&
        e.kind !== EdgeKind.CoveredByTemplate
      ) continue;
      if (seen.has(e.from)) continue;
      seen.add(e.from);
      const n = this.mergedNodes.get(e.from);
      if (n) out.push(n);
    }
    return out;
  }
}
