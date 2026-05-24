import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '../indexer/index-builder.ts';
import {
  detectChangedAndDeleted,
  updateChanged,
} from '../indexer/incremental-updater.ts';
import { GraphQueryApi } from '../query/query-api.ts';
import { GraphStore } from '../store/graph-store.ts';
import { EdgeKind } from '../schema/edge-kind.ts';

function setupFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-graph-incr-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
  );
  mkdirSync(join(root, 'packages', 'alpha', 'src'), { recursive: true });
  mkdirSync(join(root, 'packages', 'beta', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'alpha', 'package.json'),
    JSON.stringify({ name: '@demo/alpha', main: 'src/index.ts' }, null, 2),
  );
  writeFileSync(
    join(root, 'packages', 'beta', 'package.json'),
    JSON.stringify({ name: '@demo/beta', main: 'src/index.ts' }, null, 2),
  );
  writeFileSync(
    join(root, 'packages', 'alpha', 'src', 'index.ts'),
    "export function alpha() { return 1; }",
  );
  writeFileSync(
    join(root, 'packages', 'beta', 'src', 'index.ts'),
    "import { alpha } from '@demo/alpha';\nexport const useAlpha = alpha;",
  );
  return root;
}

describe('updateChanged', () => {
  test('updates a changed file in place', () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      // Sleep just long enough for mtime resolution to actually move.
      const newBody = "export function alpha() { return 42; }\nexport function ALPHA_v2() { return 'v2'; }";
      writeFileSync(join(root, 'packages', 'alpha', 'src', 'index.ts'), newBody);
      const r = updateChanged({
        projectRoot: root,
        changedFiles: ['packages/alpha/src/index.ts'],
      });
      expect(r.updated).toContain('packages/alpha/src/index.ts');
      expect(r.deleted).toEqual([]);
      const q = GraphQueryApi.fromStore(root);
      const file = q.findFile('packages/alpha/src/index.ts')!;
      const syms = q.symbolsIn(file.id).map((s) => s.label).sort();
      expect(syms).toContain('alpha');
      expect(syms).toContain('ALPHA_v2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('skips a file whose fingerprint did not change', () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const r = updateChanged({
        projectRoot: root,
        changedFiles: ['packages/alpha/src/index.ts'],
      });
      expect(r.skipped).toContain('packages/alpha/src/index.ts');
      expect(r.updated).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('removes nodes + edges for deleted files', () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      unlinkSync(join(root, 'packages', 'alpha', 'src', 'index.ts'));
      const r = updateChanged({
        projectRoot: root,
        deletedFiles: ['packages/alpha/src/index.ts'],
      });
      expect(r.deleted).toContain('packages/alpha/src/index.ts');
      const q = GraphQueryApi.fromStore(root);
      expect(q.findFile('packages/alpha/src/index.ts')).toBeUndefined();
      expect(q.findSymbol('alpha', { exact: true }).length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('detectChangedAndDeleted finds new and removed files', () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      // Add a new file.
      writeFileSync(
        join(root, 'packages', 'beta', 'src', 'extra.ts'),
        "export const extra = 1;",
      );
      // Delete an existing one.
      unlinkSync(join(root, 'packages', 'alpha', 'src', 'index.ts'));
      const d = detectChangedAndDeleted(root);
      expect(d.changed).toContain('packages/beta/src/extra.ts');
      expect(d.deleted).toContain('packages/alpha/src/index.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('package-depends-on is rebuilt after an incremental update', () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      // Make beta stop importing alpha.
      writeFileSync(
        join(root, 'packages', 'beta', 'src', 'index.ts'),
        "export const standalone = true;",
      );
      const r = updateChanged({
        projectRoot: root,
        changedFiles: ['packages/beta/src/index.ts'],
      });
      expect(r.updated).toContain('packages/beta/src/index.ts');
      const store = new GraphStore(root);
      const snap = store.loadSnapshot();
      const deps = [...snap.edges.values()].filter(
        (e) => e.kind === EdgeKind.PackageDependsOn,
      );
      expect(deps).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('throws when called before any index exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-graph-incr-empty-'));
    try {
      expect(() => updateChanged({ projectRoot: root, changedFiles: ['x.ts'] })).toThrow(
        /store missing/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
