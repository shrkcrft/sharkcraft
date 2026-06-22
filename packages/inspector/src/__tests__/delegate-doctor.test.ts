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

  test('one Ok check when every recipe is delegatable', () => {
    const checks = buildDelegateRecipeChecks(cfg([RECIPE]));
    expect(checks).toHaveLength(1);
    expect(checks[0]?.severity).toBe(DoctorSeverity.Ok);
    expect(checks[0]?.category).toBe('delegate');
    expect(checks[0]?.message).toContain('all delegatable');
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
