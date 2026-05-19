// Verifies the agent-feedback fix: `runDoctor` should flag every
// `actionhints-*` check as advisory so the doctor's existing fold pipeline
// collapses them into a single summary line by default. Before this fix,
// 300+ action-hint warnings dominated the headline (the "367 warnings"
// complaint from the downstream Claude agent).
import { describe, expect, test } from 'bun:test';
import * as nodePath from 'node:path';
import { inspectSharkcraft, runDoctor } from '../index.ts';

const DOGFOOD = nodePath.resolve(__dirname, '../../../../examples/dogfood-target');

describe('action-hint quality checks are advisory', () => {
  test('every actionhints-* check sets advisory: true', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD });
    const result = runDoctor(inspection);
    const actionHints = result.checks.filter((c) => c.id.startsWith('actionhints-'));
    // The dogfood target carries some high-priority rules; either it has
    // hints (zero findings) or it doesn't — the contract is just that
    // when findings exist they are all advisory.
    for (const c of actionHints) {
      expect(c.advisory).toBe(true);
    }
  });
});
