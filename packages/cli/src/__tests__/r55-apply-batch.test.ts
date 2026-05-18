/**
 * `shrk apply --batch` runner (pure unit + plan parsing).
 *
 * The runner itself spawns subprocesses, which we cover end-to-end in
 * the validation gates (shell). Here we cover the pure pieces:
 *   - plan parsing rejects malformed JSON, unknown kinds, bad args.
 *   - batch-id is a deterministic content-hash of the plan.
 *   - dry-run records the would-be commands without spawning.
 */
import { describe, expect, test } from 'bun:test';
import {
  ApplyBatchPlanError,
  APPLY_BATCH_SCHEMA,
  computeBatchId,
  parseApplyBatchPlan,
  runApplyBatch,
} from '../task-next/apply-batch-runner.ts';

describe('parseApplyBatchPlan', () => {
  test('rejects non-JSON input', () => {
    expect(() => parseApplyBatchPlan('not json')).toThrow(ApplyBatchPlanError);
  });
  test('rejects wrong schema', () => {
    expect(() => parseApplyBatchPlan(JSON.stringify({ schema: 'bogus', steps: [] }))).toThrow(
      /schema must be/,
    );
  });
  test('rejects unknown step kind', () => {
    expect(() =>
      parseApplyBatchPlan(
        JSON.stringify({ schema: APPLY_BATCH_SCHEMA, steps: [{ kind: 'nope' }] }),
      ),
    ).toThrow(/kind must be one of/);
  });
  test('rejects non-flat args', () => {
    expect(() =>
      parseApplyBatchPlan(
        JSON.stringify({
          schema: APPLY_BATCH_SCHEMA,
          steps: [{ kind: 'action-hints', args: { nested: { not: 'ok' } } } as unknown],
        }),
      ),
    ).toThrow(/string\|number\|boolean\|string\[\]/);
  });
  test('accepts a minimal valid plan', () => {
    const plan = parseApplyBatchPlan(
      JSON.stringify({
        schema: APPLY_BATCH_SCHEMA,
        steps: [{ kind: 'action-hints' }, { kind: 'template-drift', args: { 'allow-divergent': true } }],
      }),
    );
    expect(plan.steps.length).toBe(2);
    expect(plan.steps[1]!.args).toEqual({ 'allow-divergent': true });
  });
});

describe('computeBatchId', () => {
  test('is deterministic and prefixed', () => {
    const plan = parseApplyBatchPlan(
      JSON.stringify({
        schema: APPLY_BATCH_SCHEMA,
        steps: [{ kind: 'action-hints' }],
      }),
    );
    const a = computeBatchId(plan);
    const b = computeBatchId(plan);
    expect(a).toBe(b);
    expect(a.startsWith('batch_')).toBe(true);
  });
  test('differs for different plans', () => {
    const p1 = parseApplyBatchPlan(
      JSON.stringify({ schema: APPLY_BATCH_SCHEMA, steps: [{ kind: 'action-hints' }] }),
    );
    const p2 = parseApplyBatchPlan(
      JSON.stringify({ schema: APPLY_BATCH_SCHEMA, steps: [{ kind: 'template-drift' }] }),
    );
    expect(computeBatchId(p1)).not.toBe(computeBatchId(p2));
  });
});

describe('runApplyBatch dry-run', () => {
  test('dry-run does not spawn subprocesses; returns success', () => {
    const plan = parseApplyBatchPlan(
      JSON.stringify({
        schema: APPLY_BATCH_SCHEMA,
        steps: [{ kind: 'action-hints' }, { kind: 'template-drift' }],
      }),
    );
    const report = runApplyBatch({
      plan,
      allowDivergent: false,
      dryRun: true,
      cwd: process.cwd(),
      shrkBin: '/nonexistent/shrk',
    });
    expect(report.success).toBe(true);
    expect(report.steps.length).toBe(2);
    expect(report.steps[0]!.outcome).toBe('no-op');
    expect(report.steps[0]!.stdoutJson).toMatchObject({ dryRun: true });
    expect(report.batchId.startsWith('batch_')).toBe(true);
  });
});
