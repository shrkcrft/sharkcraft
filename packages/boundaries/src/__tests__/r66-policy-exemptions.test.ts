/**
 * Policy exemptions + the lexical scan zones.
 *
 * The two failure modes this covers: a hit in a comment counted as a real
 * violation (false positive that trains people to ignore the gate), and an
 * exemption that DELETES a hit instead of reporting it as suppressed (which
 * makes a real exemption indistinguishable from a stale glob).
 */
import { describe, expect, test } from 'bun:test';
import type { IPolicyRule } from '@shrkcrft/core';
import { evaluatePolicy, type IPolicyUnit } from '../policy/evaluate-policy.ts';
import { lexCodeZones, zoneAt } from '../extract/code-zones.ts';

const BASE: IPolicyRule = {
  id: 'no-now',
  surface: 'ts',
  pattern: 'Date\\.now',
  message: 'non-deterministic',
};

function run(rule: IPolicyRule, units: IPolicyUnit[]) {
  return evaluatePolicy([rule], () => units);
}

const MIXED = [
  'const a = Date.now();',
  '// we used to call Date.now() here',
  "const s = 'Date.now()';",
  '/* Date.now in a block comment */',
].join('\n');

describe('policy scan zones', () => {
  test('the default `all` counts every zone (the historical behaviour)', () => {
    const report = run(BASE, [{ path: 'a.ts', content: MIXED, baseLine: 1 }]);
    expect(report.findings).toHaveLength(4);
    expect(report.suppressed).toHaveLength(0);
  });

  test('`code` keeps only the real call and reports the rest as suppressed', () => {
    const report = run({ ...BASE, scan: 'code' }, [{ path: 'a.ts', content: MIXED, baseLine: 1 }]);
    expect(report.findings.map((f) => f.line)).toEqual([1]);
    expect(report.suppressed.map((s) => s.via)).toEqual(['scanZone', 'scanZone', 'scanZone']);
  });

  test('`comments` inverts it — for finding forbidden content in the prose itself', () => {
    const report = run({ ...BASE, scan: 'comments' }, [{ path: 'a.ts', content: MIXED, baseLine: 1 }]);
    expect(report.findings.map((f) => f.line)).toEqual([2, 4]);
  });

  test('`strings` targets exactly what a language-scoped linter cannot see', () => {
    const report = run({ ...BASE, scan: 'strings' }, [{ path: 'a.ts', content: MIXED, baseLine: 1 }]);
    expect(report.findings.map((f) => f.line)).toEqual([3]);
  });

  test('zoning is skipped for an inline-template unit (already a string body)', () => {
    const report = run({ ...BASE, scan: 'code' }, [
      { path: 'a.ts', content: '<p>{{ Date.now() }}</p>', baseLine: 7, inlineTemplate: true },
    ]);
    expect(report.findings.map((f) => f.line)).toEqual([7]);
  });

  test('lexCodeZones classifies each offset', () => {
    const src = "a /*c*/ 'str' // tail";
    const zones = lexCodeZones(src);
    expect(zoneAt(zones, 0)).toBe('code');
    expect(zoneAt(zones, src.indexOf('/*c*/'))).toBe('comment');
    expect(zoneAt(zones, src.indexOf("'str'"))).toBe('string');
    expect(zoneAt(zones, src.indexOf('// tail'))).toBe('comment');
  });
});

describe('policy exemptions', () => {
  test('exemptLines suppresses a hit on its line or the line above', () => {
    const content = [
      'const a = Date.now(); // policy-allow:no-now',
      '// policy-allow:no-now',
      'const b = Date.now();',
      'const c = Date.now();',
    ].join('\n');
    const report = run({ ...BASE, exemptLines: 'policy-allow:no-now' }, [
      { path: 'a.ts', content, baseLine: 1 },
    ]);
    expect(report.findings.map((f) => f.line)).toEqual([4]);
    expect(report.suppressed.map((s) => `${s.line}:${s.via}`)).toEqual(['1:exemptLines', '3:exemptLines']);
  });

  test('an exempt FILE reports its hits as suppressed rather than deleting them', () => {
    const report = run(BASE, [
      { path: 'a.ts', content: 'Date.now()', baseLine: 1 },
      { path: 'b.spec.ts', content: 'Date.now()', baseLine: 1, exemptFile: true },
    ]);
    expect(report.findings.map((f) => f.file)).toEqual(['a.ts']);
    expect(report.suppressed).toEqual([
      { ruleId: 'no-now', file: 'b.spec.ts', line: 1, match: 'Date.now', via: 'exemptFiles' },
    ]);
    expect(report.rules[0]!.suppressedCount).toBe(1);
  });
});

describe('policy — the loud-skip contract', () => {
  test('a rule that scanned 0 units is SKIPPED, never a pass', () => {
    const report = run(BASE, []);
    expect(report.rules[0]!.status).toBe('skipped');
    expect(report.evaluated).toBe(0);
    expect(report.skipped[0]!.failed).toBe(false);
    expect(report.verdict).toBe('pass');
  });

  test('failOnEmpty makes that skip a real failure', () => {
    const report = run({ ...BASE, failOnEmpty: true }, []);
    expect(report.rules[0]!.status).toBe('failed');
    expect(report.skipped[0]!.failed).toBe(true);
    expect(report.verdict).toBe('errors');
  });
});
