import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import {
  buildTaskPacket,
  createFeatureBundleState,
  FeatureBundleStatus,
  inspectSharkcraft,
  markBundlePlanApplied,
  readFeatureBundle,
  recomputeBundleStatus,
  setBundleDependencies,
  upsertBundlePlan,
  writeFeatureBundle,
} from '../index.ts';

function tempRoot(): string {
  const r = mkdtempSync(nodePath.join(tmpdir(), 'shrk-r9-'));
  writeFileSync(nodePath.join(r, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
  return r;
}

describe('bundle dependency persistence + record-apply', () => {
  it('persists dependencies into bundle.json and groups by wave', async () => {
    const root = tempRoot();
    try {
      const inspection = await inspectSharkcraft({ cwd: root });
      const packet = buildTaskPacket(inspection, 'a');
      let bundle = createFeatureBundleState({ id: 'b1', task: 'a', projectRoot: root, packet });
      bundle = upsertBundlePlan(bundle, {
        name: 'a',
        templateId: 't',
        variables: {},
        missingVariables: [],
        file: 'a.json',
        status: 'reviewed',
        expectedTargets: [],
      });
      bundle = upsertBundlePlan(bundle, {
        name: 'b',
        templateId: 't',
        variables: {},
        missingVariables: [],
        file: 'b.json',
        status: 'reviewed',
        expectedTargets: [],
      });
      bundle = setBundleDependencies(
        bundle,
        [{ from: 'a', to: 'b', reason: 'test' }],
        ['a', 'b'],
      );
      writeFeatureBundle(root, bundle);
      const read = readFeatureBundle(root, 'b1');
      expect(read?.dependencies.length).toBe(1);
      expect(read?.planGroups.length).toBe(2);
      expect(read?.planGroups[0]?.planNames).toEqual(['a']);
      expect(read?.planGroups[1]?.planNames).toEqual(['b']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('markBundlePlanApplied flips a single plan and recompute lifts status', () => {
    const base = createFeatureBundleState({
      id: 'x',
      task: 't',
      projectRoot: '/tmp',
      packet: { recommendedPipelines: [], recommendedCliCommands: [], forbiddenActions: [] } as any,
    });
    const withPlan = upsertBundlePlan(base, {
      name: 'p',
      templateId: 'foo',
      variables: {},
      missingVariables: [],
      file: 'p.json',
      status: 'reviewed',
      expectedTargets: [],
    });
    const applied = markBundlePlanApplied(withPlan, 'p', 'via apply-assist');
    expect(applied.plans[0]?.status).toBe('applied');
    expect(recomputeBundleStatus(applied).status).toBe(FeatureBundleStatus.Applied);
  });
});
