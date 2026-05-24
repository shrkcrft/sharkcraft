import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { EdgeKind } from '../schema/edge-kind.ts';
import { NodeKind } from '../schema/node-kind.ts';
import type { IEdge } from '../schema/edge.ts';
import type { INode } from '../schema/node.ts';
import { findFileCycles, summarizeCycles } from '../query/cycle-detection.ts';

function fileNode(path: string): INode {
  return {
    id: `file:${path}`,
    kind: NodeKind.File,
    label: path,
    path,
  };
}
function importEdge(from: string, to: string): IEdge {
  return {
    id: createHash('sha1').update(`${from}|${to}|imports`).digest('hex'),
    from: `file:${from}`,
    to: `file:${to}`,
    kind: EdgeKind.ImportsFile,
    source: 'test',
  };
}

describe('summarizeCycles', () => {
  test('linear chain has no cycles', () => {
    const nodes = ['a.ts', 'b.ts', 'c.ts'].map(fileNode);
    const edges = [importEdge('a.ts', 'b.ts'), importEdge('b.ts', 'c.ts')];
    const r = summarizeCycles(nodes, edges);
    expect(r.cycleCount).toBe(0);
    expect(r.largestCycleSize).toBe(0);
    expect(r.filesInCycles).toBe(0);
  });

  test('2-file cycle detected', () => {
    const nodes = ['a.ts', 'b.ts'].map(fileNode);
    const edges = [importEdge('a.ts', 'b.ts'), importEdge('b.ts', 'a.ts')];
    const r = summarizeCycles(nodes, edges);
    expect(r.cycleCount).toBe(1);
    expect(r.largestCycleSize).toBe(2);
    expect(r.filesInCycles).toBe(2);
  });

  test('3-file cycle (a→b→c→a) detected as one SCC', () => {
    const nodes = ['a.ts', 'b.ts', 'c.ts'].map(fileNode);
    const edges = [
      importEdge('a.ts', 'b.ts'),
      importEdge('b.ts', 'c.ts'),
      importEdge('c.ts', 'a.ts'),
    ];
    const r = summarizeCycles(nodes, edges);
    expect(r.cycleCount).toBe(1);
    expect(r.largestCycleSize).toBe(3);
  });

  test('two disjoint cycles counted separately', () => {
    const nodes = ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map(fileNode);
    const edges = [
      importEdge('a.ts', 'b.ts'),
      importEdge('b.ts', 'a.ts'),
      importEdge('c.ts', 'd.ts'),
      importEdge('d.ts', 'c.ts'),
    ];
    const r = summarizeCycles(nodes, edges);
    expect(r.cycleCount).toBe(2);
    expect(r.largestCycleSize).toBe(2);
    expect(r.filesInCycles).toBe(4);
  });

  test('non-file edges (e.g. applies-rule) are ignored', () => {
    const nodes = ['a.ts', 'b.ts'].map(fileNode);
    nodes.push({ id: 'rule:demo', kind: NodeKind.Rule, label: 'demo' });
    const edges: IEdge[] = [
      importEdge('a.ts', 'b.ts'),
      importEdge('b.ts', 'a.ts'),
      {
        id: 'x',
        from: 'file:a.ts',
        to: 'rule:demo',
        kind: EdgeKind.AppliesRule,
        source: 'test',
      },
    ];
    const r = summarizeCycles(nodes, edges);
    expect(r.cycleCount).toBe(1);
  });

  test('findFileCycles returns the full SCC list with file paths', () => {
    const nodes = ['a.ts', 'b.ts', 'c.ts'].map(fileNode);
    const edges = [
      importEdge('a.ts', 'b.ts'),
      importEdge('b.ts', 'c.ts'),
      importEdge('c.ts', 'a.ts'),
    ];
    const pathById = new Map(nodes.map((n) => [n.id, n.path!]));
    const cycles = findFileCycles(nodes, edges, pathById);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.size).toBe(3);
    expect([...(cycles[0]!.paths ?? [])].sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  test('findFileCycles sorts cycles by size desc then id asc', () => {
    const nodes = ['x1.ts', 'x2.ts', 'y1.ts', 'y2.ts', 'y3.ts'].map(fileNode);
    const edges = [
      // Small cycle x1↔x2 (size 2)
      importEdge('x1.ts', 'x2.ts'),
      importEdge('x2.ts', 'x1.ts'),
      // Bigger cycle y1→y2→y3→y1 (size 3)
      importEdge('y1.ts', 'y2.ts'),
      importEdge('y2.ts', 'y3.ts'),
      importEdge('y3.ts', 'y1.ts'),
    ];
    const cycles = findFileCycles(nodes, edges);
    expect(cycles).toHaveLength(2);
    expect(cycles[0]!.size).toBe(3); // bigger comes first
    expect(cycles[1]!.size).toBe(2);
  });

  test('findFileCycles omits paths when pathById not provided', () => {
    const nodes = ['a.ts', 'b.ts'].map(fileNode);
    const edges = [importEdge('a.ts', 'b.ts'), importEdge('b.ts', 'a.ts')];
    const cycles = findFileCycles(nodes, edges);
    expect(cycles[0]!.paths).toBeUndefined();
  });

  test('handles a 1000-file linear chain without stack overflow', () => {
    const N = 1000;
    const nodes: INode[] = [];
    const edges: IEdge[] = [];
    for (let i = 0; i < N; i += 1) {
      nodes.push(fileNode(`f${i}.ts`));
      if (i > 0) edges.push(importEdge(`f${i - 1}.ts`, `f${i}.ts`));
    }
    // No throw is the assertion; cycle count is 0.
    const r = summarizeCycles(nodes, edges);
    expect(r.cycleCount).toBe(0);
  });
});
