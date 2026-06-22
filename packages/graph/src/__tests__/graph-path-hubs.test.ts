import { describe, expect, test } from 'bun:test';
import { GraphQueryApi } from '../query/query-api.ts';
import type { IEdge } from '../schema/edge.ts';
import { EdgeKind } from '../schema/edge-kind.ts';
import type { IGraphSnapshot } from '../schema/graph-snapshot.ts';
import type { INode } from '../schema/node.ts';
import { NodeKind } from '../schema/node-kind.ts';

function fileNode(path: string): INode {
  return { id: `file:${path}`, kind: NodeKind.File, label: path.split('/').pop() ?? path, path };
}
function symNode(path: string, name: string, line = 1): INode {
  return { id: `symbol:${path}#${name}`, kind: NodeKind.Symbol, label: name, path, line };
}
function edge(from: string, to: string, kind: EdgeKind, line?: number): IEdge {
  return {
    id: `${from}|${to}|${kind}`,
    from,
    to,
    kind,
    source: 'test@v1',
    ...(line !== undefined ? { data: { line } } : {}),
  };
}

function snapshot(nodes: INode[], edges: IEdge[]): IGraphSnapshot {
  return {
    manifest: {
      schema: 'sharkcraft.graph/v1' as IGraphSnapshot['manifest']['schema'],
      projectRoot: '/tmp/x',
      lastIndexedAt: '2026-06-21T00:00:00.000Z',
      lastIndexDurationMs: 1,
      filesIndexed: nodes.filter((n) => n.kind === NodeKind.File).length,
      nodesByKind: {},
      edgesByKind: {},
      digest: 'd',
      workspacePackages: [],
    },
    nodes: new Map(nodes.map((n) => [n.id, n])),
    edges: new Map(edges.map((e) => [e.id, e])),
    files: new Map(),
  };
}

// a.ts ──imports──▶ b.ts ──imports──▶ c.ts (declares `hot`)
// a.ts ──calls────▶ hot           b.ts ──references──▶ hot
// d.ts is isolated.
function fixture(): GraphQueryApi {
  const a = fileNode('a.ts');
  const b = fileNode('b.ts');
  const c = fileNode('c.ts');
  const d = fileNode('d.ts');
  const hot = symNode('c.ts', 'hot', 10);
  const mid = symNode('b.ts', 'mid', 5);
  const edges = [
    edge(a.id, b.id, EdgeKind.ImportsFile),
    edge(b.id, c.id, EdgeKind.ImportsFile),
    edge(c.id, hot.id, EdgeKind.DeclaresSymbol),
    edge(b.id, mid.id, EdgeKind.DeclaresSymbol),
    edge(a.id, hot.id, EdgeKind.CallsSymbol, 10),
    edge(b.id, hot.id, EdgeKind.ReferencesSymbol, 3),
    edge(a.id, mid.id, EdgeKind.ReferencesSymbol, 7),
  ];
  return new GraphQueryApi(snapshot([a, b, c, d, hot, mid], edges));
}

describe('GraphQueryApi.pathBetween', () => {
  test('finds a multi-hop import chain (a → b → c) as the shortest path', () => {
    const api = fixture();
    const path = api.pathBetween('file:a.ts', 'file:c.ts');
    expect(path.found).toBe(true);
    expect(path.hops.map((h) => h.kind)).toEqual([EdgeKind.ImportsFile, EdgeKind.ImportsFile]);
    expect(path.hops.map((h) => h.from.id)).toEqual(['file:a.ts', 'file:b.ts']);
    expect(path.hops.at(-1)?.to.id).toBe('file:c.ts');
  });

  test('prefers a direct call edge (1 hop) and carries its line', () => {
    const api = fixture();
    const path = api.pathBetween('file:a.ts', 'symbol:c.ts#hot');
    expect(path.found).toBe(true);
    expect(path.hops).toHaveLength(1);
    expect(path.hops[0]?.kind).toBe(EdgeKind.CallsSymbol);
    expect(path.hops[0]?.line).toBe(10);
  });

  test('reports no path from an isolated node, with explored > 0', () => {
    const api = fixture();
    const path = api.pathBetween('file:d.ts', 'file:c.ts');
    expect(path.found).toBe(false);
    expect(path.hops).toHaveLength(0);
    expect(path.explored).toBeGreaterThan(0);
    expect(path.reason).toContain('no code path');
  });

  test('same source and target is a trivial found path with no hops', () => {
    const api = fixture();
    const path = api.pathBetween('file:a.ts', 'file:a.ts');
    expect(path.found).toBe(true);
    expect(path.hops).toHaveLength(0);
  });

  test('missing endpoint fails honestly (not "unrelated")', () => {
    const api = fixture();
    const path = api.pathBetween('symbol:nope#x', 'file:c.ts');
    expect(path.found).toBe(false);
    expect(path.reason).toContain('source node is not in the graph');
  });

  test('respects a maxDepth cap', () => {
    const api = fixture();
    // a → b → c needs depth 2; cap at 1 must not find it.
    const path = api.pathBetween('file:a.ts', 'file:c.ts', { maxDepth: 1 });
    expect(path.found).toBe(false);
  });
});

describe('GraphQueryApi.topHubs', () => {
  test('ranks the most-referenced symbol first by distinct dependents', () => {
    const api = fixture();
    const hubs = api.topHubs();
    // `hot` is referenced by a (call) + b (reference) = 2 distinct files;
    // `mid` by a only = 1.
    expect(hubs.symbols[0]?.node.id).toBe('symbol:c.ts#hot');
    expect(hubs.symbols[0]?.inDegree).toBe(2);
    expect(hubs.symbols.find((h) => h.node.id === 'symbol:b.ts#mid')?.inDegree).toBe(1);
  });

  test('ranks files by distinct importers', () => {
    const api = fixture();
    const hubs = api.topHubs();
    const fileIds = hubs.files.map((h) => h.node.id);
    expect(fileIds).toContain('file:b.ts');
    expect(fileIds).toContain('file:c.ts');
    for (const h of hubs.files) expect(h.inDegree).toBe(1);
  });

  test('honors the limit', () => {
    const api = fixture();
    expect(api.topHubs(1).symbols).toHaveLength(1);
  });

  test('directDependentsOf a symbol = referencing files + subtype files, not the owner', () => {
    // b.ts declares S; a.ts references S; c.ts declares Sub which implements S.
    const aFile = fileNode('a.ts');
    const bFile = fileNode('b.ts');
    const cFile = fileNode('c.ts');
    const S = symNode('b.ts', 'S');
    const Sub = symNode('c.ts', 'Sub');
    const edges = [
      edge(bFile.id, S.id, EdgeKind.DeclaresSymbol),
      edge(cFile.id, Sub.id, EdgeKind.DeclaresSymbol),
      edge(aFile.id, S.id, EdgeKind.ReferencesSymbol),
      edge(Sub.id, S.id, EdgeKind.ImplementsSymbol),
    ];
    const api = new GraphQueryApi(snapshot([aFile, bFile, cFile, S, Sub], edges));
    const deps = api.directDependentsOf(S).map((n) => n.id).sort();
    // a.ts references it; c.ts declares an implementer; b.ts (owner) is excluded.
    expect(deps).toEqual(['file:a.ts', 'file:c.ts']);
  });

  test('pathPrefix scopes hubs to one subsystem', () => {
    // pkg-a/svc.ts declares `aHot`, referenced by two files; pkg-b/util.ts
    // declares `bHot`, referenced by one. A scope to pkg-a sees only `aHot`.
    const aFile = fileNode('pkg-a/svc.ts');
    const bFile = fileNode('pkg-b/util.ts');
    const refA1 = fileNode('pkg-a/one.ts');
    const refA2 = fileNode('pkg-b/two.ts');
    const aHot = symNode('pkg-a/svc.ts', 'aHot', 3);
    const bHot = symNode('pkg-b/util.ts', 'bHot', 4);
    const edges = [
      edge(aFile.id, aHot.id, EdgeKind.DeclaresSymbol),
      edge(bFile.id, bHot.id, EdgeKind.DeclaresSymbol),
      edge(refA1.id, aHot.id, EdgeKind.ReferencesSymbol),
      edge(refA2.id, aHot.id, EdgeKind.ReferencesSymbol),
      edge(refA1.id, bHot.id, EdgeKind.ReferencesSymbol),
    ];
    const api = new GraphQueryApi(snapshot([aFile, bFile, refA1, refA2, aHot, bHot], edges));
    const scoped = api.topHubs(10, 'pkg-a');
    expect(scoped.symbols.map((h) => h.node.label)).toEqual(['aHot']);
    // The global view still sees both.
    expect(api.topHubs(10).symbols.map((h) => h.node.label).sort()).toEqual(['aHot', 'bHot']);
  });
});
