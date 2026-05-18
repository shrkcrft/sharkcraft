import { describe, expect, test } from 'bun:test';
import {
  BundleReplayStatus,
  buildBundleDiff,
  renderBundleDiff,
  type IFeatureBundle,
} from '../index.ts';

function makeBundle(over: Partial<IFeatureBundle>): IFeatureBundle {
  return {
    schema: 'sharkcraft.feature-bundle/v1',
    id: 'a',
    task: 'demo',
    createdAt: '2026-05-13T00:00:00Z',
    updatedAt: '2026-05-13T00:00:00Z',
    projectRoot: '/tmp/r15',
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

void BundleReplayStatus;

describe('r15 bundle diff', () => {
  test('no changes when comparing identical bundles', () => {
    const a = makeBundle({ id: 'a' });
    const b = makeBundle({ ...a, id: 'b' });
    const diff = buildBundleDiff(a, b);
    expect(diff.summary.totalChanges).toBe(0);
    expect(diff.addedPlans).toEqual([]);
    expect(diff.removedPlans).toEqual([]);
  });

  test('detects added / removed / changed plans', () => {
    const a = makeBundle({
      plans: [
        {
          name: 'plan-a',
          templateId: 'tpl',
          variables: {},
          missingVariables: [],
          file: 'plans/plan-a.json',
          status: 'saved',
          expectedTargets: ['src/a.ts'],
        },
      ],
    });
    const b = makeBundle({
      id: 'b',
      plans: [
        {
          name: 'plan-a',
          templateId: 'tpl',
          variables: {},
          missingVariables: [],
          file: 'plans/plan-a.json',
          status: 'applied',
          expectedTargets: ['src/a.ts', 'src/b.ts'],
        },
        {
          name: 'plan-b',
          templateId: 'tpl',
          variables: {},
          missingVariables: [],
          file: 'plans/plan-b.json',
          status: 'saved',
          expectedTargets: [],
        },
      ],
    });
    const diff = buildBundleDiff(a, b);
    expect(diff.addedPlans).toEqual(['plan-b']);
    expect(diff.changedPlans.some((c) => c.name === 'plan-a' && c.change === 'status')).toBe(true);
    expect(diff.changedPlans.some((c) => c.name === 'plan-a' && c.change === 'targets')).toBe(true);
  });

  test('HTML / markdown / json renderers all return non-empty content', () => {
    const a = makeBundle({ id: 'a', task: 'one' });
    const b = makeBundle({ id: 'b', task: 'two' });
    const diff = buildBundleDiff(a, b);
    const html = renderBundleDiff(diff, 'html');
    expect(html.includes('<script')).toBe(false);
    expect(html).toContain('Bundle diff');
    expect(renderBundleDiff(diff, 'markdown')).toContain('## Summary');
    const parsed = JSON.parse(renderBundleDiff(diff, 'json'));
    expect(parsed.schema).toBe('sharkcraft.bundle-diff/v1');
  });
});
