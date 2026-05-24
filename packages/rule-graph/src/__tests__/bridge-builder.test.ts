import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '@shrkcrft/graph';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { buildBridge } from '../bridge/bridge-builder.ts';
import { RuleGraphQueryApi } from '../query/rule-graph-query-api.ts';

function setupFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-rule-graph-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo-root', workspaces: ['packages/*'] }, null, 2),
  );
  mkdirSync(join(root, 'packages', 'alpha', 'src'), { recursive: true });
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'alpha', 'package.json'),
    JSON.stringify({ name: '@demo/alpha', main: 'src/index.ts' }, null, 2),
  );
  writeFileSync(
    join(root, 'packages', 'alpha', 'src', 'index.ts'),
    "export const alpha = 1;",
  );
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    [
      "export default {",
      "  projectName: 'demo',",
      "  pathFiles: ['paths.ts'],",
      "  boundaryFiles: ['boundaries.ts'],",
      "};",
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'sharkcraft', 'boundaries.ts'),
    [
      "export default [{",
      "  id: 'demo.no-cycles',",
      "  title: 'demo no cycles',",
      "  severity: 'error',",
      "  from: ['packages/alpha/src/**'],",
      "  forbiddenImports: ['@demo/beta'],",
      "  tags: ['demo'],",
      "  appliesWhen: ['review-code'],",
      "}];",
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'sharkcraft', 'paths.ts'),
    [
      "export default [{",
      "  id: 'demo.engine-packages',",
      "  title: 'engine packages',",
      "  type: 'path',",
      "  priority: 'critical',",
      "  scope: ['monorepo'],",
      "  appliesWhen: ['create-feature'],",
      "  content: 'Engine packages under packages/',",
      "  metadata: { path: 'packages' },",
      "}];",
    ].join('\n'),
  );
  return root;
}

describe('buildBridge', () => {
  test('emits applies-rule, matches-path bridge edges', async () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const inspection = await inspectSharkcraft({ cwd: root });
      const r = await buildBridge({ projectRoot: root, inspection });
      expect(r.manifest.schema).toBe('sharkcraft.rule-graph/v1');
      // 1 boundary rule × 1 matching file = 1 applies-rule edge.
      expect(r.manifest.sourceCounts['rule']).toBe(1);
      // 1 path convention × 1 file under packages/ = 1 matches-path edge.
      expect(r.manifest.sourceCounts['path']).toBeGreaterThanOrEqual(1);

      const api = RuleGraphQueryApi.fromStores(root);
      const forFile = api.forFile('packages/alpha/src/index.ts');
      expect(forFile).toBeDefined();
      expect(forFile!.rules.map((h) => h.target.id)).toContain('boundary:demo.no-cycles');
      expect(forFile!.paths.map((h) => h.target.id)).toContain('path:demo.engine-packages');

      const filesUnderRule = api.filesFor('boundary:demo.no-cycles');
      expect(filesUnderRule.some((f) => f.path === 'packages/alpha/src/index.ts')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('missingDescription points to the right next command', () => {
    const root = setupFixture();
    try {
      // No graph yet → graph index hint.
      expect(RuleGraphQueryApi.missingDescription(root)).toMatch(/graph index/);
      buildFullIndex({ projectRoot: root });
      // Graph exists, bridge missing → rule-graph index hint.
      expect(RuleGraphQueryApi.missingDescription(root)).toMatch(/rule-graph index/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
