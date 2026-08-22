/**
 * `check wiring --fix` — the deterministic autofix planner.
 *
 * The bar here is deliberately asymmetric: a MISSED fix is a minor annoyance,
 * a WRONG fix is the gate writing the very thing it is meant to verify. So the
 * refusal cases carry as much weight as the success cases, and every one of
 * them asserts that nothing was planned.
 */
import { describe, expect, test } from 'bun:test';
import type { IWiringRule } from '@shrkcrft/core';
import { planWiringFix, type IWiringFixFile } from '../wiring/plan-wiring-fix.ts';
import type { IWiringViolation } from '../wiring/evaluate-wiring.ts';

const RULE: IWiringRule = {
  id: 'r',
  declared: { files: ['src/h/*.ts'], extract: 'export-names', match: '_H$' },
  registered: { files: ['src/reg.ts'], extract: 'array-members', anchor: 'H' },
};

function violation(token: string): IWiringViolation {
  return { ruleId: 'r', token, file: 'src/h/a.ts', line: 1, severity: 'error', direction: 'declared-missing' };
}

function files(regContent: string, path = 'src/reg.ts'): IWiringFixFile[] {
  return [{ path, content: regContent }];
}

describe('planWiringFix — the unambiguous case', () => {
  test('appends into a multi-line array and keeps the closing bracket on its own line', () => {
    const plan = planWiringFix(RULE, [violation('B_H')], files('export const H = [\n  A_H,\n];\n'));
    expect(plan.skipped).toEqual([]);
    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0]!.nextContent).toBe('export const H = [\n  A_H,\n  B_H,\n];\n');
  });

  test('appends into a single-line array without reformatting it', () => {
    const plan = planWiringFix(RULE, [violation('B_H')], files('export const H = [A_H];\n'));
    expect(plan.edits[0]!.nextContent).toBe('export const H = [A_H, B_H];\n');
  });

  test('several missing tokens accumulate into one final content', () => {
    const plan = planWiringFix(
      RULE,
      [violation('B_H'), violation('C_H')],
      files('export const H = [\n  A_H,\n];\n'),
    );
    expect(plan.edits).toHaveLength(2);
    // The LAST edit carries every insertion — that is what the writer uses.
    expect(plan.edits[1]!.nextContent).toBe('export const H = [\n  A_H,\n  B_H,\n  C_H,\n];\n');
  });

  test('matches the quoting style already in the array', () => {
    const plan = planWiringFix(RULE, [violation('beta')], files("export const H = ['alpha'];\n"));
    expect(plan.edits[0]!.nextContent).toBe("export const H = ['alpha', 'beta'];\n");
  });

  test('reads through a freeze wrapper', () => {
    const plan = planWiringFix(RULE, [violation('B_H')], files('export const H = Object.freeze([\n  A_H,\n]);\n'));
    expect(plan.edits[0]!.nextContent).toBe('export const H = Object.freeze([\n  A_H,\n  B_H,\n]);\n');
  });

  test('an empty array still receives the first member', () => {
    const plan = planWiringFix(RULE, [violation('A_H')], files('export const H = [];\n'));
    expect(plan.edits[0]!.nextContent).toBe('export const H = [A_H];\n');
  });
});

describe('planWiringFix — refuses anything ambiguous', () => {
  function expectRefusal(rule: IWiringRule, fs: IWiringFixFile[], reason: string) {
    const plan = planWiringFix(rule, [violation('B_H')], fs);
    expect(plan.edits).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]!.reason).toBe(reason as never);
  }

  test('two registered sinks — which array should it join?', () => {
    expectRefusal(
      {
        ...RULE,
        registered: [
          { files: ['src/reg.ts'], extract: 'array-members', anchor: 'H' },
          { files: ['src/reg2.ts'], extract: 'array-members', anchor: 'O' },
        ],
      },
      [...files('export const H = [A_H];\n'), { path: 'src/reg2.ts', content: 'export const O = [];\n' }],
      'ambiguous-sink',
    );
  });

  test('a chain rule has no single sink', () => {
    expectRefusal(
      {
        id: 'r',
        chain: [
          { files: ['src/h/*.ts'], extract: 'export-names' },
          { files: ['src/reg.ts'], extract: 'array-members', anchor: 'H' },
        ],
      },
      files('export const H = [A_H];\n'),
      'ambiguous-sink',
    );
  });

  test('a regex sink is not an array to append to', () => {
    expectRefusal(
      { ...RULE, registered: { files: ['src/reg.ts'], extract: 'regex-capture', pattern: 'H = \\[(\\w+)' } },
      files('export const H = [A_H];\n'),
      'sink-not-an-array',
    );
  });

  test('a sink glob matching several files has no unique insertion point', () => {
    expectRefusal(
      { ...RULE, registered: { files: ['src/*.ts'], extract: 'array-members', anchor: 'H' } },
      [
        { path: 'src/one.ts', content: 'export const H = [A_H];\n' },
        { path: 'src/two.ts', content: 'export const H = [A_H];\n' },
      ],
      'ambiguous-sink-file',
    );
  });

  test('a sink glob matching NO file is refused, not silently skipped', () => {
    expectRefusal(RULE, [{ path: 'src/other.ts', content: '' }], 'ambiguous-sink-file');
  });

  test('the anchor array appearing twice in one file is ambiguous', () => {
    expectRefusal(RULE, files('export const H = [A_H];\nconst H = [B];\n'), 'array-not-found');
  });

  test('a missing anchor array is refused', () => {
    expectRefusal(RULE, files('export const OTHER = [A_H];\n'), 'array-not-found');
  });
});

describe('planWiringFix — scope', () => {
  test('parity `registered-missing` violations are never auto-fixed', () => {
    const parityViolation: IWiringViolation = {
      ruleId: 'r', token: 'GHOST', file: 'src/reg.ts', line: 1,
      severity: 'error', direction: 'registered-missing',
    };
    const plan = planWiringFix(RULE, [parityViolation], files('export const H = [GHOST];\n'));
    expect(plan.edits).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });

  test('violations from another rule are ignored', () => {
    const other: IWiringViolation = { ...violation('X_H'), ruleId: 'other' };
    const plan = planWiringFix(RULE, [other], files('export const H = [];\n'));
    expect(plan.edits).toEqual([]);
  });
});
