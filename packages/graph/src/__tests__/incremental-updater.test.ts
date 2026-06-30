import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '../indexer/index-builder.ts';
import {
  detectChangedAndDeleted,
  detectGraphFreshness,
  updateChanged,
} from '../indexer/incremental-updater.ts';
import { GraphQueryApi } from '../query/query-api.ts';
import { clearGraphApiCache, loadGraphApiCached } from '../query/graph-api-cache.ts';
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

  test('detectGraphFreshness categorizes modified / added / deleted', () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      // modify an indexed file (content + size change → sha differs)
      writeFileSync(
        join(root, 'packages', 'alpha', 'src', 'index.ts'),
        'export function alpha() { return 99; }',
      );
      // add a new source file
      writeFileSync(join(root, 'packages', 'beta', 'src', 'extra.ts'), 'export const extra = 1;');
      // delete an indexed file
      unlinkSync(join(root, 'packages', 'beta', 'src', 'index.ts'));
      const f = detectGraphFreshness(root);
      expect(f.hasIndex).toBe(true);
      expect(f.modified).toContain('packages/alpha/src/index.ts');
      expect(f.added).toContain('packages/beta/src/extra.ts');
      expect(f.deleted).toContain('packages/beta/src/index.ts');
      // back-compat adapter: `changed` is the union of modified + added.
      const d = detectChangedAndDeleted(root);
      expect(d.changed).toContain('packages/alpha/src/index.ts');
      expect(d.changed).toContain('packages/beta/src/extra.ts');
      expect(d.deleted).toContain('packages/beta/src/index.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('loadGraphApiCached caches the API and invalidates when the index is rebuilt', () => {
    clearGraphApiCache();
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const a1 = loadGraphApiCached(root);
      const a2 = loadGraphApiCached(root);
      expect(a1).not.toBeNull();
      expect(a2).toBe(a1); // unchanged store → same cached instance

      // Add a file and rebuild → meta.json changes → cache must invalidate.
      writeFileSync(join(root, 'packages', 'beta', 'src', 'extra.ts'), 'export const extra = 1;');
      buildFullIndex({ projectRoot: root });
      const a3 = loadGraphApiCached(root);
      expect(a3).not.toBe(a1); // rebuilt store → fresh instance
      expect(a3!.findFile('packages/beta/src/extra.ts')).toBeDefined(); // reflects the new index
    } finally {
      clearGraphApiCache();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('loadGraphApiCached returns null when no index exists', () => {
    clearGraphApiCache();
    const root = mkdtempSync(join(tmpdir(), 'shrk-no-graph-'));
    try {
      expect(loadGraphApiCached(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('staleFilesAmong flags modified result files and drops deleted ones', () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      // Snapshot loaded NOW (the "stale index" the agent queries after editing).
      const q = GraphQueryApi.fromStore(root);
      expect(q.staleFilesAmong(root, ['packages/alpha/src/index.ts'])).toEqual({
        modified: [],
        deleted: [],
      });
      // Edit alpha, delete beta — without reindexing.
      writeFileSync(
        join(root, 'packages', 'alpha', 'src', 'index.ts'),
        'export function alpha() { return 42; }',
      );
      unlinkSync(join(root, 'packages', 'beta', 'src', 'index.ts'));
      const stale = q.staleFilesAmong(root, [
        'packages/alpha/src/index.ts',
        'packages/beta/src/index.ts',
      ]);
      expect(stale.modified).toEqual(['packages/alpha/src/index.ts']);
      expect(stale.deleted).toEqual(['packages/beta/src/index.ts']);
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

// ── GR1: inbound caller / reference / heritage edges must survive an
// incremental reindex of the DECLARING file. Re-indexing `lib` must not wipe
// the calls/implements edges that ORIGINATE in unchanged `app`.
const LIB = 'packages/lib/src/index.ts';
const APP = 'packages/app/src/index.ts';

function setupTwoPackageFixture(libBody: string, appBody: string): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-graph-gr1-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
  );
  mkdirSync(join(root, 'packages', 'lib', 'src'), { recursive: true });
  mkdirSync(join(root, 'packages', 'app', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'lib', 'package.json'),
    JSON.stringify({ name: '@demo/lib', main: 'src/index.ts' }, null, 2),
  );
  writeFileSync(
    join(root, 'packages', 'app', 'package.json'),
    JSON.stringify({ name: '@demo/app', main: 'src/index.ts' }, null, 2),
  );
  writeFileSync(join(root, 'packages', 'lib', 'src', 'index.ts'), libBody);
  writeFileSync(join(root, 'packages', 'app', 'src', 'index.ts'), appBody);
  return root;
}

describe('updateChanged inbound edges (GR1)', () => {
  test('caller edge from an unchanged file survives a reindex of the callee file', () => {
    const root = setupTwoPackageFixture(
      'export function foo() { return 1; }\n',
      "import { foo } from '@demo/lib';\nexport function run() { return foo(); }\n",
    );
    try {
      buildFullIndex({ projectRoot: root });
      const q0 = GraphQueryApi.fromStore(root);
      const foo0 = q0.findSymbol('foo', { exact: true })[0]!;
      expect(q0.callersOf(foo0.id).map((n) => n.path)).toEqual([APP]);

      // Edit ONLY lib: `foo` is byte-identical, but a sibling symbol is added so
      // the file fingerprint changes and lib is genuinely re-extracted.
      writeFileSync(
        join(root, 'packages', 'lib', 'src', 'index.ts'),
        'export function foo() { return 1; }\nexport function helper() { return 2; }\n',
      );
      const r = updateChanged({ projectRoot: root, changedFiles: [LIB] });
      expect(r.updated).toContain(LIB);

      const q1 = GraphQueryApi.fromStore(root);
      const foo1 = q1.findSymbol('foo', { exact: true })[0]!;
      // Without the fix this is [] — the inbound call edge was silently deleted.
      expect(q1.callersOf(foo1.id).map((n) => n.path)).toEqual([APP]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('implements (subtype) edge from an unchanged file survives a reindex', () => {
    const root = setupTwoPackageFixture(
      'export interface IShape { area(): number; }\n',
      "import type { IShape } from '@demo/lib';\nexport class Circle implements IShape { area() { return 1; } }\n",
    );
    try {
      buildFullIndex({ projectRoot: root });
      const q0 = GraphQueryApi.fromStore(root);
      const shape0 = q0.findSymbol('IShape', { exact: true })[0]!;
      expect(q0.subtypesOf(shape0.id).map((n) => n.label)).toEqual(['Circle']);

      writeFileSync(
        join(root, 'packages', 'lib', 'src', 'index.ts'),
        'export interface IShape { area(): number; }\nexport interface IExtra { tag: string; }\n',
      );
      updateChanged({ projectRoot: root, changedFiles: [LIB] });

      const q1 = GraphQueryApi.fromStore(root);
      const shape1 = q1.findSymbol('IShape', { exact: true })[0]!;
      expect(q1.subtypesOf(shape1.id).map((n) => n.label)).toEqual(['Circle']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('renaming a called symbol drops the stale edge and re-stitches the referrer', () => {
    const root = setupTwoPackageFixture(
      'export function foo() { return 1; }\n',
      "import { foo } from '@demo/lib';\nexport function run() { return foo(); }\n",
    );
    try {
      buildFullIndex({ projectRoot: root });
      const oldFooId = `symbol:${LIB}#foo`;
      const q0 = GraphQueryApi.fromStore(root);
      expect(q0.callersOf(oldFooId).map((n) => n.path)).toEqual([APP]);

      // Rename foo -> bar in BOTH files, but report ONLY lib as changed. The
      // referrer (app) must still be re-stitched against the new symbol table.
      writeFileSync(
        join(root, 'packages', 'lib', 'src', 'index.ts'),
        'export function bar() { return 1; }\n',
      );
      writeFileSync(
        join(root, 'packages', 'app', 'src', 'index.ts'),
        "import { bar } from '@demo/lib';\nexport function run() { return bar(); }\n",
      );
      updateChanged({ projectRoot: root, changedFiles: [LIB] });

      const q1 = GraphQueryApi.fromStore(root);
      // foo no longer exists — no node and no phantom inbound caller edge.
      expect(q1.findSymbol('foo', { exact: true })).toHaveLength(0);
      expect(q1.callersOf(oldFooId)).toEqual([]);
      // The caller was rebuilt against the renamed symbol.
      const bar1 = q1.findSymbol('bar', { exact: true })[0]!;
      expect(q1.callersOf(bar1.id).map((n) => n.path)).toEqual([APP]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
