import { describe, expect, test } from 'bun:test';
import { EdgeKind } from '../schema/edge-kind.ts';
import type { IEdge } from '../schema/edge.ts';
import { summarizeUnresolvedImports } from '../indexer/unresolved-imports.ts';

function edge(from: string, to: string, kind: EdgeKind = EdgeKind.ImportsFile): IEdge {
  return { id: `${from}->${to}`, from, to, kind, source: 'test' };
}

describe('summarizeUnresolvedImports', () => {
  test('empty edge list → zeros', () => {
    const r = summarizeUnresolvedImports([]);
    expect(r.unresolvedImportCount).toBe(0);
    expect(r.filesWithUnresolvedImports).toBe(0);
    expect(r.unresolvedImportSamples).toEqual([]);
  });

  test('counts unresolved edges, tracks distinct files + sorted samples', () => {
    const edges: IEdge[] = [
      edge('file:a.ts', 'unresolved:./missing'),
      edge('file:a.ts', 'unresolved:./another-missing'),
      edge('file:b.ts', 'unresolved:./missing'),
      edge('file:c.ts', 'external:react'), // not counted (external resolution)
      edge('file:d.ts', 'file:e.ts'), // not counted (resolved)
    ];
    const r = summarizeUnresolvedImports(edges);
    expect(r.unresolvedImportCount).toBe(3);
    expect(r.filesWithUnresolvedImports).toBe(2); // a + b
    expect(r.unresolvedImportSamples).toEqual([
      './another-missing',
      './missing',
    ]);
  });

  test('caps sample list at default 10 entries', () => {
    const edges: IEdge[] = [];
    for (let i = 0; i < 15; i += 1) {
      edges.push(edge(`file:f${i}.ts`, `unresolved:./missing-${i}`));
    }
    const r = summarizeUnresolvedImports(edges);
    expect(r.unresolvedImportCount).toBe(15);
    expect(r.filesWithUnresolvedImports).toBe(15);
    expect(r.unresolvedImportSamples).toHaveLength(10);
  });

  test('non-ImportsFile edges are ignored', () => {
    const edges: IEdge[] = [
      // Even though target starts with unresolved:, this edge kind isn't
      // ImportsFile so it shouldn't count.
      edge('file:a.ts', 'unresolved:./x', EdgeKind.DeclaresSymbol),
    ];
    const r = summarizeUnresolvedImports(edges);
    expect(r.unresolvedImportCount).toBe(0);
  });

  test('respects custom sample limit', () => {
    const edges: IEdge[] = [];
    for (let i = 0; i < 5; i += 1) {
      edges.push(edge(`file:f${i}.ts`, `unresolved:./m-${i}`));
    }
    const r = summarizeUnresolvedImports(edges, 2);
    expect(r.unresolvedImportSamples).toHaveLength(2);
  });
});
