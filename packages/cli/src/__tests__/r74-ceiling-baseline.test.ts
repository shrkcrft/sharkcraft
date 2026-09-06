/**
 * Round 74 — `mode: 'ceiling'` baselines.
 *
 * Teams hand-roll the same ratchet over and over ("no more than N raw literals
 * of kind X", "bundle under N kB", "warnings ≤ N") as a bespoke shell gate, and
 * every one of those scripts is outside the trust layer: no loud-skip, no
 * shared `--json`, no `selfTest`, no stale-selector detection. Folding the
 * shape into `baselines[]` is what makes reaching for the engine cheaper than
 * writing the script — so the properties that must hold are the boring ones:
 * fail at N+1, pass at N, and never bless silently.
 */
import { describe, expect, test } from 'bun:test';
import type { IBaselineRule } from '@shrkcrft/core';
import { ceilingValue, evaluateCeiling } from '@shrkcrft/boundaries';

const RULE: IBaselineRule = {
  id: 'ratchet',
  mode: 'ceiling',
  ceiling: 200,
  direction: 'at-most',
  compute: { kind: 'command', run: 'echo 0' },
};

describe('evaluateCeiling', () => {
  test('passes at N and fails at N+1', () => {
    expect(evaluateCeiling(RULE, 200).failed).toBe(false);
    expect(evaluateCeiling(RULE, 201).failed).toBe(true);
    expect(evaluateCeiling(RULE, 199).failed).toBe(false);
  });

  test('reports headroom so a ratchet nearing its limit is visible before it trips', () => {
    expect(evaluateCeiling(RULE, 180).slack).toBe(20);
    expect(evaluateCeiling(RULE, 205).slack).toBe(-5);
  });

  test('at-least inverts it into a floor — a coverage ratchet, same engine', () => {
    const floor: IBaselineRule = { ...RULE, direction: 'at-least' };
    expect(evaluateCeiling(floor, 201).failed).toBe(false);
    expect(evaluateCeiling(floor, 199).failed).toBe(true);
    expect(evaluateCeiling(floor, 200).failed).toBe(false);
  });

  test('a missing ceiling is 0, never an accidental pass', () => {
    const bare: IBaselineRule = { id: 'x', mode: 'ceiling', compute: { kind: 'command', run: 'x' } };
    expect(evaluateCeiling(bare, 1).failed).toBe(true);
  });
});

describe('ceilingValue', () => {
  test('a numeric stdout IS the measurement (wc -l, a byte count, a warning total)', () => {
    expect(ceilingValue(RULE, '42\n')).toBe(42);
    expect(ceilingValue(RULE, ' 7 ')).toBe(7);
  });

  test('anything else is measured by entry count, the same way a ledger counts', () => {
    expect(ceilingValue(RULE, 'a\nb\nc\n')).toBe(3);
  });
});
