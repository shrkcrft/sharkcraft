import { describe, expect, test } from 'bun:test';
import { buildBundleDiff, type IFeatureBundle, type IFeatureBundlePlan } from '../index.ts';

function plan(over: Partial<IFeatureBundlePlan>): IFeatureBundlePlan {
  return {
    name: 'plan-1',
    templateId: 'tpl-a',
    variables: { foo: 'bar' },
    missingVariables: [],
    file: 'plans/plan-1.json',
    status: 'saved',
    expectedTargets: ['src/a.ts'],
    ...over,
  } as IFeatureBundlePlan;
}

function bundle(over: Partial<IFeatureBundle>): IFeatureBundle {
  return {
    schema: 'sharkcraft.feature-bundle/v1',
    id: 'a',
    task: 'demo',
    createdAt: '2026-05-13T00:00:00Z',
    updatedAt: '2026-05-13T00:00:00Z',
    projectRoot: '/tmp/r16',
    status: 'draft' as unknown as IFeatureBundle['status'],
    plans: [],
    planGroups: [],
    dependencies: [],
    validations: [],
    reports: [],
    affectedFiles: [],
    affectedAreas: [],
    riskLevel: 'low' as unknown as IFeatureBundle['riskLevel'],
    nextAction: null,
    commandHints: [],
    warnings: [],
    ...over,
  } as IFeatureBundle;
}

describe('r16 bundle rename detection', () => {
  test('detects rename when template + variables match', () => {
    const a = bundle({ id: 'a', plans: [plan({ name: 'old-name' })] });
    const b = bundle({
      id: 'b',
      plans: [plan({ name: 'new-name' })],
    });
    const diff = buildBundleDiff(a, b);
    expect(diff.renamedPlans.length).toBe(1);
    expect(diff.renamedPlans[0]!.from).toBe('old-name');
    expect(diff.renamedPlans[0]!.to).toBe('new-name');
    expect(diff.addedPlans).toEqual([]);
    expect(diff.removedPlans).toEqual([]);
  });
  test('unrelated plans stay as add+remove', () => {
    const a = bundle({
      id: 'a',
      plans: [plan({ name: 'x', templateId: 'tpl-x', expectedTargets: ['src/x.ts'] })],
    });
    const b = bundle({
      id: 'b',
      plans: [plan({ name: 'y', templateId: 'tpl-y', expectedTargets: ['src/y.ts'], variables: { other: 'v' } })],
    });
    const diff = buildBundleDiff(a, b);
    expect(diff.renamedPlans.length).toBe(0);
    expect(diff.addedPlans).toContain('y');
    expect(diff.removedPlans).toContain('x');
  });
  test('lower-confidence pairs surface as possible renames', () => {
    const a = bundle({
      id: 'a',
      plans: [plan({ name: 'a-plan', templateId: 'tpl-a', expectedTargets: ['src/a.ts'], variables: {} })],
    });
    const b = bundle({
      id: 'b',
      plans: [plan({ name: 'b-plan', templateId: 'tpl-a', expectedTargets: [], variables: {} })],
    });
    const diff = buildBundleDiff(a, b);
    expect(diff.renamedPlans.length).toBe(0);
    expect(diff.possibleRenames.length + diff.addedPlans.length + diff.removedPlans.length).toBeGreaterThan(0);
  });
});
