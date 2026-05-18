import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import {
  buildPlanDependencyGraph,
  buildTaskPacket,
  createFeatureBundleState,
  inspectSharkcraft,
  upsertBundlePlan,
} from '../index.ts';

describe('plan dependency graph', () => {
  it('topologically orders contract → impl', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-pdg-'));
    try {
      writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
      const inspection = await inspectSharkcraft({ cwd: root });
      const packet = buildTaskPacket(inspection, 'a');
      let bundle = createFeatureBundleState({ id: 'b1', task: 'a', projectRoot: root, packet });
      bundle = upsertBundlePlan(bundle, {
        name: 'contract',
        templateId: 't1',
        variables: {},
        missingVariables: [],
        file: 'contract.json',
        status: 'reviewed',
        expectedTargets: ['src/user.contract.ts'],
      });
      bundle = upsertBundlePlan(bundle, {
        name: 'impl',
        templateId: 't2',
        variables: {},
        missingVariables: [],
        file: 'impl.json',
        status: 'reviewed',
        expectedTargets: ['src/user.impl.ts'],
      });
      const g = buildPlanDependencyGraph(inspection, bundle);
      expect(g.order).toContain('contract');
      expect(g.order).toContain('impl');
      const ic = g.order.indexOf('contract');
      const ii = g.order.indexOf('impl');
      expect(ic).toBeLessThan(ii);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
