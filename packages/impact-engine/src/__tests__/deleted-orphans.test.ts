import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex, GraphQueryApi } from '@shrkcrft/graph';
import { DELETED_ORPHANS_SCHEMA, findDeletedOrphans } from '../engine/analyzer.ts';

/**
 * Tiny two-package fixture: `beta` imports + calls a symbol from `alpha`.
 * Pre-edit index (alpha still present) is exactly the snapshot the orphan
 * check runs against — so `alpha` deleted should surface `beta` as an
 * orphaned importer.
 */
function setupFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-deleted-orphans-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo-root', workspaces: ['packages/*'] }, null, 2),
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
    'export function alpha() { return 1; }\n',
  );
  // Import statement is on line 1 → the imports-file edge carries line 1.
  writeFileSync(
    join(root, 'packages', 'beta', 'src', 'index.ts'),
    "import { alpha } from '@demo/alpha';\nexport function useAlpha() { return alpha(); }\n",
  );
  return root;
}

const ALPHA = 'packages/alpha/src/index.ts';
const BETA = 'packages/beta/src/index.ts';

describe('findDeletedOrphans', () => {
  test('surfaces a surviving importer of a deleted file with path:line', () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const graph = GraphQueryApi.fromStore(root);
      const report = findDeletedOrphans(graph, [ALPHA]);

      expect(report.schema).toBe(DELETED_ORPHANS_SCHEMA);
      expect(report.resolvedDeleted).toContain(ALPHA);
      expect(report.unresolvedDeleted).toHaveLength(0);

      // beta still imports alpha → orphan via an imports-file edge, line 1.
      const importOrphan = report.orphans.find(
        (o) => o.path === BETA && o.via === 'import',
      );
      expect(importOrphan).toBeDefined();
      expect(importOrphan!.deletedFile).toBe(ALPHA);
      expect(importOrphan!.line).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('surfaces a surviving reference to a deleted symbol', () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const graph = GraphQueryApi.fromStore(root);
      const report = findDeletedOrphans(graph, [ALPHA]);

      // beta calls alpha() → orphan via a symbol reference, naming the symbol.
      const refOrphan = report.orphans.find(
        (o) => o.path === BETA && o.via === 'reference' && o.symbol === 'alpha',
      );
      expect(refOrphan).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('no orphans when nothing was deleted', () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const graph = GraphQueryApi.fromStore(root);
      const report = findDeletedOrphans(graph, []);
      expect(report.orphans).toHaveLength(0);
      expect(report.resolvedDeleted).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a deleted file absent from the index lands in unresolvedDeleted', () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const graph = GraphQueryApi.fromStore(root);
      const report = findDeletedOrphans(graph, ['packages/ghost/src/index.ts']);
      expect(report.unresolvedDeleted).toContain('packages/ghost/src/index.ts');
      expect(report.orphans).toHaveLength(0);
      expect(report.diagnostics.some((d) => d.includes('not in index'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
