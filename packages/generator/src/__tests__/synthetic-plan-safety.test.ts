import { describe, expect, test } from 'bun:test';
import { evaluateSavedPlanInPlace, writeSyntheticPlan } from '../synthetic-plan.ts';
import { FileChangeType } from '../file-change.ts';
import type { ISavedPlan } from '../saved-plan.ts';

describe('synthetic-plan apply path safety', () => {
  test('a traversal relativePath becomes a Conflict and is refused (no write outside root)', () => {
    const plan = {
      templateId: '__evil',
      templateName: '__evil',
      expectedChanges: [
        { relativePath: '../escape/pwned.txt', operation: { kind: 'create', content: 'PWNED' } },
      ],
    } as unknown as ISavedPlan;

    const gen = evaluateSavedPlanInPlace(plan, '/tmp/shrk-synthetic-proj');
    expect(gen.hasConflicts).toBe(true);
    expect(gen.changes[0]!.type).toBe(FileChangeType.Conflict);
    expect(gen.changes[0]!.reason).toContain('unsafe target path');

    // writeSyntheticPlan must refuse a plan with conflicts.
    const r = writeSyntheticPlan(gen);
    expect(r.ok).toBe(false);
  });

  test('an absolute relativePath is also refused', () => {
    const plan = {
      templateId: '__evil',
      templateName: '__evil',
      expectedChanges: [{ relativePath: '/etc/pwned.txt', operation: { kind: 'create', content: 'x' } }],
    } as unknown as ISavedPlan;
    const gen = evaluateSavedPlanInPlace(plan, '/tmp/shrk-synthetic-proj');
    expect(gen.hasConflicts).toBe(true);
    expect(gen.changes[0]!.type).toBe(FileChangeType.Conflict);
  });
});
