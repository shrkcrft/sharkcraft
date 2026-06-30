import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStore, isGraphStoreCorruptError } from '../store/graph-store.ts';
import { NodeKind } from '../schema/node-kind.ts';
import { EdgeKind } from '../schema/edge-kind.ts';

function buildStore(root: string): GraphStore {
  const store = new GraphStore(root);
  store.writeSnapshot(
    [
      {
        id: 'file:src/a.ts',
        kind: NodeKind.File,
        label: 'a.ts',
        path: 'src/a.ts',
        data: { language: 'typescript' },
      },
      { id: 'symbol:src/a.ts#Foo', kind: NodeKind.Symbol, label: 'Foo', path: 'src/a.ts', line: 1 },
    ],
    [
      {
        id: 'edge-1',
        from: 'file:src/a.ts',
        to: 'symbol:src/a.ts#Foo',
        kind: EdgeKind.DeclaresSymbol,
        source: 'test@v1',
      },
    ],
    [{ path: 'src/a.ts', mtime: 1, sha1: 'abc', sizeBytes: 10, language: 'typescript', nodeId: 'file:src/a.ts' }],
    {
      projectRoot: root,
      lastIndexedAt: 'now',
      lastIndexDurationMs: 1,
      filesIndexed: 1,
      nodesByKind: {},
      edgesByKind: {},
      workspacePackages: [],
    },
  );
  return store;
}

describe('GraphStore corrupt-store handling (E2)', () => {
  test('a malformed JSONL line makes loadSnapshot throw the typed corrupt error citing the line', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-graph-corrupt-'));
    try {
      const store = buildStore(root);
      // Append a garbled row to a nodes JSONL file — a truncated/partial write
      // or a hand-edit. The store should refuse to load with a TYPED error, not
      // a raw `Fatal: JSON Parse error` that crashes the whole CLI.
      const nodesDir = join(root, '.sharkcraft', 'graph', 'nodes');
      const jsonl = readdirSync(nodesDir).find((f) => f.endsWith('.jsonl'))!;
      appendFileSync(join(nodesDir, jsonl), '{ this is not valid json\n');

      let thrown: unknown;
      try {
        store.loadSnapshot();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeDefined();
      expect(isGraphStoreCorruptError(thrown)).toBe(true);
      const err = thrown as { message: string; code?: string; details?: Record<string, unknown> };
      // Typed + actionable, NOT a bare SyntaxError.
      expect(err.message).toContain('corrupt');
      expect(err.message).not.toContain('Fatal');
      expect(err.code).toBe('SHRK_IO_ERROR');
      expect(err.details?.['kind']).toBe('graph-store-corrupt');
      expect(typeof err.details?.['file']).toBe('string');
      // The bad row is the 2nd line of the JSONL (one valid row precedes it).
      expect(err.details?.['line']).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('isGraphStoreCorruptError ignores unrelated errors', () => {
    expect(isGraphStoreCorruptError(new Error('boom'))).toBe(false);
    expect(isGraphStoreCorruptError(undefined)).toBe(false);
    expect(isGraphStoreCorruptError({ details: { kind: 'something-else' } })).toBe(false);
  });

  test('a healthy store still loads cleanly (no false corruption)', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-graph-ok-'));
    try {
      const store = buildStore(root);
      const snap = store.loadSnapshot();
      expect(snap.nodes.size).toBe(2);
      expect(snap.edges.size).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
