import { describe, expect, test } from 'bun:test';
import type { RiskLevel } from '../schema/impact-analysis.ts';
import { classifyRisk, type IRiskInputs } from '../engine/risk-score.ts';

/** Build a fully-zeroed input, overlaying only the fields under test. */
function inputs(partial: Partial<IRiskInputs>): IRiskInputs {
  return {
    directCount: 0,
    transitiveCount: 0,
    packagesTouched: 0,
    rulesTouched: 0,
    templatesTouched: 0,
    publicApiTouched: false,
    callerFilesCount: 0,
    ...partial,
  };
}

interface ICase {
  name: string;
  input: Partial<IRiskInputs>;
  expected: RiskLevel;
}

/**
 * Table pinning every weight threshold and every risk cut-point
 * (score >= 8 critical, >= 5 high, >= 2 medium, else low).
 */
const CASES: readonly ICase[] = [
  // --- all-zero floor ---
  { name: 'no signal → low', input: {}, expected: 'low' },

  // --- directCount: >=5 adds 2, >0 adds 1 (4 vs 5 boundary) ---
  { name: 'directCount 1 → +1 → low', input: { directCount: 1 }, expected: 'low' },
  { name: 'directCount 4 (below 5) → +1 → low', input: { directCount: 4 }, expected: 'low' },
  { name: 'directCount 5 (at 5) → +2 → medium', input: { directCount: 5 }, expected: 'medium' },

  // --- transitiveCount: >=50 adds 3, >=10 adds 2 (9 / 10 / 50 boundary) ---
  { name: 'transitiveCount 9 (below 10) → +0 → low', input: { transitiveCount: 9 }, expected: 'low' },
  { name: 'transitiveCount 10 (at 10) → +2 → medium', input: { transitiveCount: 10 }, expected: 'medium' },
  { name: 'transitiveCount 50 (at 50) → +3 → medium alone', input: { transitiveCount: 50 }, expected: 'medium' },

  // --- packagesTouched: >=5 adds 2, >=2 adds 1 (1 / 2 / 5 boundary) ---
  { name: 'packagesTouched 1 (below 2) → +0 → low', input: { packagesTouched: 1 }, expected: 'low' },
  { name: 'packagesTouched 2 (at 2) → +1 → low alone', input: { packagesTouched: 2 }, expected: 'low' },
  { name: 'packagesTouched 5 (at 5) → +2 → medium', input: { packagesTouched: 5 }, expected: 'medium' },

  // --- single-weight branches ---
  { name: 'publicApiTouched → +2 → medium', input: { publicApiTouched: true }, expected: 'medium' },
  { name: 'callerFilesCount 10 → +1 → low alone', input: { callerFilesCount: 10 }, expected: 'low' },
  {
    name: 'rules + templates touched → +1 +1 → medium',
    input: { rulesTouched: 1, templatesTouched: 1 },
    expected: 'medium',
  },

  // --- cut-point boundaries built from combinations ---
  {
    name: 'score 4 (5 direct + 10 transitive) → medium (just below high)',
    input: { directCount: 5, transitiveCount: 10 },
    expected: 'medium',
  },
  {
    name: 'score 5 (5 direct + 10 transitive + 2 packages) → high',
    input: { directCount: 5, transitiveCount: 10, packagesTouched: 2 },
    expected: 'high',
  },
  {
    name: '50 transitive outweighs 10: 5 direct + 50 transitive → score 5 → high',
    input: { directCount: 5, transitiveCount: 50 },
    expected: 'high',
  },
  {
    name: 'score 7 (5 direct + 50 transitive + 2 packages + 10 callers) → high (just below critical)',
    input: { directCount: 5, transitiveCount: 50, packagesTouched: 2, callerFilesCount: 10 },
    expected: 'high',
  },
  {
    name: 'score 8 (5 direct + 50 transitive + 5 packages + 10 callers) → critical',
    input: { directCount: 5, transitiveCount: 50, packagesTouched: 5, callerFilesCount: 10 },
    expected: 'critical',
  },
];

describe('classifyRisk', () => {
  for (const c of CASES) {
    test(c.name, () => {
      expect(classifyRisk(inputs(c.input)).risk).toBe(c.expected);
    });
  }

  test('reasons enumerate every contributing signal', () => {
    const { risk, reasons } = classifyRisk(
      inputs({
        directCount: 5,
        transitiveCount: 50,
        packagesTouched: 5,
        rulesTouched: 1,
        templatesTouched: 1,
        publicApiTouched: true,
        callerFilesCount: 10,
      }),
    );
    expect(risk).toBe('critical');
    expect(reasons).toContain('5 direct dependents');
    expect(reasons).toContain('50 transitive dependents');
    expect(reasons).toContain('5 workspace packages spanned');
    expect(reasons).toContain('1 boundary rule(s) apply');
    expect(reasons).toContain('covered by 1 template(s) — verify drift');
    expect(reasons).toContain('public API surface touched');
    expect(reasons).toContain('10 caller files');
  });

  test('no-signal input yields an empty reasons list', () => {
    expect(classifyRisk(inputs({})).reasons).toEqual([]);
  });
});
