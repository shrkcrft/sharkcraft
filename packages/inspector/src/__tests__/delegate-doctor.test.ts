import { describe, expect, test } from 'bun:test';
import { buildDelegateRecipeChecks } from '../delegate-doctor.ts';
import { DoctorSeverity } from '../doctor-result.ts';
import type { ISharkCraftConfig } from '@shrkcrft/config';

const RECIPE = {
  id: 'add-barrel-export',
  guardrailGlobs: ['src/**/index.ts'],
  allowedOps: ['export'],
  verificationIds: ['barrel-tsc'],
};

function cfg(recipes: NonNullable<ISharkCraftConfig['delegation']>['recipes'], verificationIds = ['barrel-tsc']): ISharkCraftConfig {
  return {
    verificationCommands: verificationIds.map((id) => ({ id, command: 'tsc' })),
    delegation: { recipes },
  };
}

describe('buildDelegateRecipeChecks', () => {
  test('silent when there is no delegation block', () => {
    expect(buildDelegateRecipeChecks({ projectName: 'x' })).toEqual([]);
    expect(buildDelegateRecipeChecks(null)).toEqual([]);
  });

  test('one Ok check when every recipe is healthy', () => {
    const checks = buildDelegateRecipeChecks(cfg([RECIPE]));
    expect(checks).toHaveLength(1);
    expect(checks[0]?.severity).toBe(DoctorSeverity.Ok);
    expect(checks[0]?.category).toBe('delegate');
    expect(checks[0]?.message).toContain('all healthy');
  });

  test('warns on an analysis recipe with an unknown allowedQueries entry', () => {
    const checks = buildDelegateRecipeChecks(
      cfg([{ id: 'ctx', mode: 'analysis', groundedOn: 'task-risk', allowedQueries: ['coverage', 'bogus'] } as never]),
    );
    const warn = checks.find((c) => c.code === 'recipe-unknown-query');
    expect(warn?.severity).toBe(DoctorSeverity.Warning);
    expect(warn?.message).toContain('bogus');
  });

  test('warns when escalateTo does not resolve to a patch recipe', () => {
    const checks = buildDelegateRecipeChecks(
      cfg([{ id: 'gaps', mode: 'analysis', groundedOn: 'test-impact', escalateTo: 'nope' } as never]),
    );
    const warn = checks.find((c) => c.code === 'recipe-bad-escalation');
    expect(warn?.severity).toBe(DoctorSeverity.Warning);
    expect(warn?.message).toContain('nope');
  });

  test('a Warning per non-delegatable recipe (unbound verificationId)', () => {
    const checks = buildDelegateRecipeChecks(cfg([{ ...RECIPE, verificationIds: ['ghost'] }]));
    expect(checks).toHaveLength(1);
    expect(checks[0]?.severity).toBe(DoctorSeverity.Warning);
    expect(checks[0]?.code).toBe('recipe-unverified');
    expect(checks[0]?.message).toContain('ghost');
    expect(checks[0]?.recommendedFix).toBe('shrk delegate explain add-barrel-export');
  });

  test('a Warning when a recipe declares no verificationIds', () => {
    const checks = buildDelegateRecipeChecks(cfg([{ ...RECIPE, verificationIds: [] }]));
    expect(checks[0]?.severity).toBe(DoctorSeverity.Warning);
    expect(checks[0]?.message).toContain('no verificationIds');
  });
});
