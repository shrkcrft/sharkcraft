/**
 * Round 11 — the ONE rule for "may this verdict be clean?".
 *
 * `coverageShortfall` is the authority every verdict surface defers to (the
 * CLI's envelope builder applies it to exit codes; engines only fill in the
 * numbers). So it is locked as a property over the whole small grid rather than
 * by a handful of examples: a capped scan is never clean, an empty scope is
 * clean only by an unconditional explicit acceptance, and a partial scope only
 * by an acceptance whose ratio it meets.
 */
import { describe, expect, test } from 'bun:test';
import {
  coverageAcceptance,
  coverageGap,
  coverageShortfall,
  formatCoverage,
  type IVerdictCoverage,
} from '../index.ts';

const RANGE = [0, 1, 2, 3, 4];

function grid(): IVerdictCoverage[] {
  const out: IVerdictCoverage[] = [];
  for (const examined of RANGE) {
    for (const expected of RANGE) {
      for (const capped of [false, true]) {
        for (const acceptedBy of [undefined, '--flag']) {
          for (const acceptedRatio of [undefined, 0.5]) {
            out.push({
              unit: 'units',
              expected,
              examined,
              ...(capped ? { capped } : {}),
              ...(acceptedBy !== undefined ? { acceptedBy } : {}),
              ...(acceptedRatio !== undefined ? { acceptedRatio } : {}),
            });
          }
        }
      }
    }
  }
  return out;
}

/** The documented property, restated independently of the implementation. */
function isClean(c: IVerdictCoverage): boolean {
  if (c.capped === true) return false;
  if (c.expected > 0 && c.examined >= c.expected) return true;
  if (c.acceptedBy === undefined) return false;
  if (c.acceptedRatio === undefined) return true;
  return c.expected > 0 && c.examined / c.expected >= c.acceptedRatio;
}

describe('coverageShortfall — the property grid', () => {
  test('undefined exactly when the documented property holds', () => {
    const cells = grid();
    expect(cells.length).toBe(5 * 5 * 2 * 2 * 2);
    for (const c of cells) {
      expect({ c, clean: coverageShortfall(c) === undefined }).toEqual({ c, clean: isClean(c) });
    }
  });

  test('a capped scan is never accepted, not even by a zero ratio', () => {
    const capped: IVerdictCoverage = {
      unit: 'files',
      expected: 2101,
      examined: 2000,
      capped: true,
      acceptedBy: '--flag',
      acceptedRatio: 0,
    };
    expect(coverageShortfall(capped)).toBe('capped at 2000 of 2101 files');
  });

  test('an empty scope is never accepted by a ratio — only by an unconditional acceptance', () => {
    expect(coverageShortfall({ unit: 'entries', expected: 0, examined: 0, acceptedBy: '--min', acceptedRatio: 0.5 })).toBeDefined();
    expect(coverageShortfall({ unit: 'entries', expected: 0, examined: 0, acceptedBy: '--allow-empty' })).toBeUndefined();
  });
});

describe('coverageAcceptance — an accepted gap is never silent', () => {
  test('defined exactly when a real gap was waived, and it names who waived it', () => {
    for (const c of grid()) {
      const waived = coverageGap(c) !== undefined && coverageShortfall(c) === undefined;
      const acceptance = coverageAcceptance(c);
      expect(acceptance !== undefined).toBe(waived);
      if (acceptance !== undefined) expect(acceptance).toContain(`accepted by ${c.acceptedBy}`);
    }
  });
});

describe('coverageGap / formatCoverage — the numbers are always on the page', () => {
  test('formatCoverage always states examined-of-expected', () => {
    for (const c of grid()) {
      expect(formatCoverage(c)).toContain(`${c.examined} of ${c.expected} units`);
    }
  });

  test('a partial gap names at most five labels and counts the rest', () => {
    const gap = coverageGap({
      unit: 'registered tokens',
      expected: 9,
      examined: 2,
      unexamined: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      reason: 'registered with no declared site',
    });
    expect(gap).toBe(
      'examined 2 of 9 registered tokens, 7 registered with no declared site: a, b, c, d, e (+2 more)',
    );
  });

  test('"nothing to examine" names the root discovery resolved', () => {
    expect(coverageGap({ unit: 'entries', expected: 0, examined: 0, root: '/repo/sub' })).toBe(
      '0 entries to examine under /repo/sub',
    );
  });
});
