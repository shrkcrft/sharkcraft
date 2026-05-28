import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStore } from '../store/graph-store.ts';
import { GRAPH_SCHEMA } from '../schema/schema-version.ts';
import { NodeKind } from '../schema/node-kind.ts';
import { EdgeKind } from '../schema/edge-kind.ts';

describe('GraphStore round-trip', () => {
  test('writeSnapshot + loadSnapshot preserves nodes, edges, files, manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-graph-store-'));
    try {
      const store = new GraphStore(root);
      const nodes = [
        {
          id: 'file:src/a.ts',
          kind: NodeKind.File,
          label: 'a.ts',
          path: 'src/a.ts',
          data: { language: 'typescript' },
        },
        {
          id: 'symbol:src/a.ts#Foo',
          kind: NodeKind.Symbol,
          label: 'Foo',
          path: 'src/a.ts',
          line: 3,
        },
        {
          id: 'package:demo',
          kind: NodeKind.Package,
          label: 'demo',
          path: '.',
        },
      ];
      const edges = [
        {
          id: 'edge-1',
          from: 'file:src/a.ts',
          to: 'symbol:src/a.ts#Foo',
          kind: EdgeKind.DeclaresSymbol,
          source: 'test@v1',
        },
        {
          id: 'edge-2',
          from: 'file:src/a.ts',
          to: 'package:demo',
          kind: EdgeKind.BelongsToPackage,
          source: 'test@v1',
        },
      ];
      const files = [
        {
          path: 'src/a.ts',
          mtime: 1,
          sha1: 'abc',
          sizeBytes: 10,
          language: 'typescript',
          nodeId: 'file:src/a.ts',
        },
      ];
      const written = store.writeSnapshot(nodes, edges, files, {
        projectRoot: root,
        lastIndexedAt: 'now',
        lastIndexDurationMs: 1,
        filesIndexed: 1,
        nodesByKind: {},
        edgesByKind: {},
        workspacePackages: [],
      });
      expect(written.schema).toBe(GRAPH_SCHEMA);
      expect(written.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(written.nodesByKind['file']).toBe(1);
      expect(written.edgesByKind['declares-symbol']).toBe(1);
      const loaded = store.loadSnapshot();
      expect(loaded.nodes.size).toBe(3);
      expect(loaded.edges.size).toBe(2);
      expect(loaded.files.get('src/a.ts')?.sha1).toBe('abc');
      const verify = store.verifyDigest();
      expect(verify.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('loadSnapshot throws on missing store', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-graph-missing-'));
    try {
      const store = new GraphStore(root);
      expect(store.exists()).toBe(false);
      expect(() => store.loadSnapshot()).toThrow(/store not found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('clear removes the store', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-graph-clear-'));
    try {
      const store = new GraphStore(root);
      store.writeSnapshot([], [], [], {
        projectRoot: root,
        lastIndexedAt: 'now',
        lastIndexDurationMs: 0,
        filesIndexed: 0,
        nodesByKind: {},
        edgesByKind: {},
        workspacePackages: [],
      });
      expect(store.exists()).toBe(true);
      store.clear();
      expect(store.exists()).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('writeSnapshot dedupes duplicate node and edge ids before persisting counts', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-graph-dedupe-'));
    try {
      const store = new GraphStore(root);
      const written = store.writeSnapshot(
        [
          { id: 'file:src/a.ts', kind: NodeKind.File, label: 'a.ts', path: 'src/a.ts' },
          { id: 'file:src/a.ts', kind: NodeKind.File, label: 'a.ts', path: 'src/a.ts', data: { updated: true } },
        ],
        [
          { id: 'edge-1', from: 'file:src/a.ts', to: 'package:demo', kind: EdgeKind.BelongsToPackage, source: 'test@v1' },
          { id: 'edge-1', from: 'file:src/a.ts', to: 'package:demo', kind: EdgeKind.BelongsToPackage, source: 'test@v1' },
        ],
        [],
        {
          projectRoot: root,
          lastIndexedAt: 'now',
          lastIndexDurationMs: 0,
          filesIndexed: 1,
          nodesByKind: {},
          edgesByKind: {},
          workspacePackages: [],
        },
      );
      expect(written.nodesByKind['file']).toBe(1);
      expect(written.edgesByKind['belongs-to-package']).toBe(1);
      const loaded = store.loadSnapshot();
      expect(loaded.nodes.size).toBe(1);
      expect(loaded.edges.size).toBe(1);
      expect(loaded.nodes.get('file:src/a.ts')?.data).toEqual({ updated: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
