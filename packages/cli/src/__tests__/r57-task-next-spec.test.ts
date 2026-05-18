/**
 * `shrk task --next` ranker spec insertion.
 *
 * The ranker should surface a spec-verify recommendation when a spec
 * is implementing without a passing verification, AFTER doctor blockers
 * but BEFORE stale-knowledge / template-drift / action-hint signals.
 */
import { describe, expect, test } from 'bun:test';
import { buildTaskNextReport, type ITaskNextInputs } from '../task-next/task-next-ranker.ts';

const EMPTY: ITaskNextInputs = {
  doctor: {
    passed: true,
    checks: [],
    summary: { ok: 0, info: 0, warnings: 0, errors: 0 },
  } as unknown as ITaskNextInputs['doctor'],
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
    entries: [],
  } as unknown as ITaskNextInputs['drift'],
  knowledgeLint: { categories: {} },
};

describe('task --next: spec signal', () => {
  test('returns null nextAction when nothing pending', () => {
    const report = buildTaskNextReport(EMPTY);
    expect(report.nextAction).toBeNull();
  });

  test('surfaces spec-verify when a spec is implementing without verification', () => {
    const report = buildTaskNextReport({
      ...EMPTY,
      specs: {
        implementingUnverified: [{ id: '2026-05-17-demo', title: 'demo' }],
      },
    });
    expect(report.nextAction).not.toBeNull();
    expect(report.nextAction?.command).toBe('shrk spec verify 2026-05-17-demo');
    expect(report.nextAction?.kind).toBe('investigate');
  });

  test('doctor blockers outrank spec signal', () => {
    const report = buildTaskNextReport({
      ...EMPTY,
      doctor: {
        passed: false,
        checks: [
          { severity: 'error', category: 'config-invalid', message: 'oops' } as unknown as object,
        ],
        summary: { ok: 0, info: 0, warnings: 0, errors: 1 },
      } as unknown as ITaskNextInputs['doctor'],
      specs: {
        implementingUnverified: [{ id: '2026-05-17-demo', title: 'demo' }],
      },
    });
    expect(report.nextAction?.command).toContain('doctor');
  });

  test('spec signal outranks stale-knowledge replaceWith', () => {
    const report = buildTaskNextReport({
      ...EMPTY,
      stale: {
        schema: 'sharkcraft.knowledge-stale/v1',
        entries: 1,
        totalReferences: 1,
        totalAnchors: 0,
        counts: { ok: 0, stale: 1, missing: 0, unknown: 0 },
        referenceChecks: [
          { outcome: 'stale', replaceWith: { kind: 'symbol', name: 'X' } } as unknown as object,
        ],
        anchorChecks: [],
      } as unknown as ITaskNextInputs['stale'],
      specs: {
        implementingUnverified: [{ id: '2026-05-17-demo', title: 'demo' }],
      },
    });
    expect(report.nextAction?.command).toBe('shrk spec verify 2026-05-17-demo');
  });

  test('when nextAction is doctor, spec signal still appears in secondary', () => {
    const report = buildTaskNextReport({
      ...EMPTY,
      doctor: {
        passed: false,
        checks: [
          { severity: 'error', category: 'config-invalid', message: 'oops' } as unknown as object,
        ],
        summary: { ok: 0, info: 0, warnings: 0, errors: 1 },
      } as unknown as ITaskNextInputs['doctor'],
      specs: {
        implementingUnverified: [{ id: '2026-05-17-demo', title: 'demo' }],
      },
    });
    expect(report.secondary.some((s) => s.command.includes('spec verify'))).toBe(true);
  });
});
