/**
 * `shrk task --next` ranker.
 *
 * Pure ranker over structured inputs. Deterministic priority order:
 * 1. doctor blockers → 2. stale w/ replaceWith → 3. missing-barrel
 * → 4. action-hint stubs → 5. stale w/o replaceWith → 6. forbidden-legacy
 * → 7. everything else.
 */
import { describe, expect, test } from 'bun:test';
import { DoctorSeverity } from '@shrkcrft/inspector';
import { buildTaskNextReport } from '../task-next/task-next-ranker.ts';
import type { ITaskNextInputs } from '../task-next/task-next-ranker.ts';

function makeInputs(overrides: Partial<ITaskNextInputs>): ITaskNextInputs {
  const base: ITaskNextInputs = {
    doctor: {
      passed: true,
      checks: [],
      summary: { ok: 0, info: 0, warnings: 0, errors: 0 },
    },
    stale: {
      schema: 'sharkcraft.knowledge-stale/v1',
      entries: 0,
      totalReferences: 0,
      totalAnchors: 0,
      counts: { ok: 0, stale: 0, missing: 0, unknown: 0 },
      referenceChecks: [],
      anchorChecks: [],
    } as unknown as ITaskNextInputs['stale'],
    drift: {
      schema: 'sharkcraft.template-drift/v1',
      generatedAt: '',
      entries: [],
    } as unknown as ITaskNextInputs['drift'],
    knowledgeLint: { categories: {} },
  };
  return { ...base, ...overrides };
}

describe('task --next ranker', () => {
  test('priority 1: doctor blockers beat everything', () => {
    const report = buildTaskNextReport(
      makeInputs({
        doctor: {
          passed: false,
          checks: [
            {
              id: 'x',
              title: 't',
              severity: DoctorSeverity.Error,
              message: 'oops',
            },
          ],
          summary: { ok: 0, info: 0, warnings: 0, errors: 1 },
        },
        stale: {
          schema: 'sharkcraft.knowledge-stale/v1',
          entries: 1,
          totalReferences: 1,
          totalAnchors: 0,
          counts: { ok: 0, stale: 1, missing: 0, unknown: 0 },
          referenceChecks: [
            {
              entryId: 'k',
              reference: { kind: 'symbol', symbol: 'X', path: 'a.ts' },
              outcome: 'stale',
              message: 'gone',
              replaceWith: { path: 'b.ts' },
            } as unknown as ITaskNextInputs['stale']['referenceChecks'][number],
          ],
          anchorChecks: [],
        } as unknown as ITaskNextInputs['stale'],
      }),
    );
    expect(report.nextAction?.kind).toBe('fix');
    expect(report.nextAction?.command).toBe('shrk doctor --blockers');
    // Stale-with-replaceWith is demoted to secondary.
    expect(report.secondary.some((s) => s.command.includes('--knowledge-stale --apply'))).toBe(true);
  });

  test('priority 2: stale with replaceWith beats template-drift', () => {
    const report = buildTaskNextReport(
      makeInputs({
        stale: {
          schema: 'sharkcraft.knowledge-stale/v1',
          entries: 1,
          totalReferences: 2,
          totalAnchors: 0,
          counts: { ok: 0, stale: 1, missing: 0, unknown: 0 },
          referenceChecks: [
            {
              entryId: 'k',
              reference: { kind: 'symbol', symbol: 'X', path: 'a.ts' },
              outcome: 'stale',
              message: 'gone',
              replaceWith: { path: 'b.ts' },
            },
          ],
          anchorChecks: [],
        } as unknown as ITaskNextInputs['stale'],
        drift: {
          schema: 'sharkcraft.template-drift/v1',
          generatedAt: '',
          entries: [
            {
              templateId: 't1',
              templateName: 'T1',
              status: 'fail',
              issues: [
                { code: 'missing-barrel', severity: 'warning', message: 'm' },
              ],
            },
          ],
        } as unknown as ITaskNextInputs['drift'],
      }),
    );
    expect(report.nextAction?.command).toContain('--knowledge-stale --apply');
  });

  test('priority 5: stale without replaceWith routes to investigate', () => {
    const report = buildTaskNextReport(
      makeInputs({
        stale: {
          schema: 'sharkcraft.knowledge-stale/v1',
          entries: 1,
          totalReferences: 1,
          totalAnchors: 0,
          counts: { ok: 0, stale: 1, missing: 0, unknown: 0 },
          referenceChecks: [
            {
              entryId: 'k',
              reference: { kind: 'symbol', symbol: 'X', path: 'a.ts' },
              outcome: 'stale',
              message: 'no signal',
            },
          ],
          anchorChecks: [],
        } as unknown as ITaskNextInputs['stale'],
      }),
    );
    expect(report.nextAction?.kind).toBe('investigate');
    expect(report.nextAction?.autoApplyEligible).toBe(false);
  });

  test('no outstanding work yields null nextAction', () => {
    const report = buildTaskNextReport(makeInputs({}));
    expect(report.nextAction).toBeNull();
  });
});
