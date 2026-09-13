/**
 * Round 11 §3.2 — `validateConvention` checked only id / title / kind /
 * rules-is-array, so a reference kind outside its declared union, a severity
 * no verdict can fail on (`'critical'`), a non-array `references` and garbage
 * rule shapes all validated `valid: true`. Closed unions are now rejected BY
 * NAME (the message lists the allowed values); shape problems that do not stop
 * a convention from evaluating are warnings, and the convention still loads.
 */
import { describe, expect, test } from 'bun:test';
import {
  ConventionKind,
  ConventionReferenceKind,
  ConventionSeverity,
  validateConvention,
} from '../convention.ts';

function base(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'c.x', title: 'X', kind: 'naming', severity: 'warning', rules: [], ...extra };
}

describe('closed unions are rejected, naming the allowed values', () => {
  test('the spec repro: a bogus reference kind and a numeric kind are errors, not a clean pass', () => {
    const v = validateConvention(
      base({ references: [{ kind: 'not-a-real-kind', value: 'v' }, { kind: 42 }], bogusTop: 1 }),
    );
    expect(v.valid).toBe(false);
    const kindIssues = v.issues.filter((i) => i.field.endsWith('.kind'));
    expect(kindIssues.map((i) => i.field)).toEqual(['references[0].kind', 'references[1].kind']);
    for (const i of kindIssues) expect(i.message).toContain('expected one of: file, doc, command, knowledge, rule');
    // The unknown key and the value-less reference still say so — as warnings.
    expect(v.warnings.map((w) => w.field).sort()).toEqual(['bogusTop', 'references[1].value']);
  });

  test("a severity outside the enum (or none) is an error — it could never fail `conventions check`", () => {
    for (const severity of ['critical', undefined]) {
      const v = validateConvention(base({ severity }));
      expect(v.valid).toBe(false);
      expect(v.issues[0]?.field).toBe('severity');
      expect(v.issues[0]?.message).toContain('info, warning, error');
    }
  });

  test('a rule severity outside the enum is an error for the same reason', () => {
    const v = validateConvention(base({ rules: [{ id: 'r', description: 'd', severity: 'loud' }] }));
    expect(v.valid).toBe(false);
    expect(v.issues.map((i) => i.field)).toEqual(['rules[0].severity']);
  });

  test('references that are not an array, a rule that is not an object, a pattern that does not compile', () => {
    expect(validateConvention(base({ references: 'not-an-array' })).issues.map((i) => i.field)).toEqual(['references']);
    expect(validateConvention(base({ rules: [null] })).issues.map((i) => i.field)).toEqual(['rules[0]']);
    const bad = validateConvention(base({ rules: [{ id: 'r', description: 'd', forbidMatch: '(' }] }));
    expect(bad.valid).toBe(false);
    expect(bad.issues[0]?.message).toContain('does not compile');
  });

  test('an appliesTo list that is not a list', () => {
    const v = validateConvention(base({ appliesTo: { fileGlobs: 'src/**' } }));
    expect(v.issues.map((i) => i.field)).toEqual(['appliesTo.fileGlobs']);
  });
});

describe('warnings never drop a convention', () => {
  test('unknown keys, a rule without id / description, a reference without value', () => {
    const v = validateConvention(
      base({ extra: true, rules: [{ forbidMatch: 'x' }], references: [{ kind: 'doc' }] }),
    );
    expect(v.valid).toBe(true);
    expect(v.issues).toEqual([]);
    expect(v.warnings.map((w) => w.field).sort()).toEqual([
      'extra',
      'references[0].value',
      'rules[0].description',
      'rules[0].id',
    ]);
  });
});

describe('property: every declared value passes clean', () => {
  test('every ConventionReferenceKind', () => {
    for (const kind of Object.values(ConventionReferenceKind)) {
      const v = validateConvention(base({ references: [{ kind, value: 'x' }] }));
      expect({ kind, valid: v.valid, issues: v.issues, warnings: v.warnings }).toEqual({
        kind,
        valid: true,
        issues: [],
        warnings: [],
      });
    }
  });

  test('every ConventionKind × ConventionSeverity, with a fully-formed rule', () => {
    for (const kind of Object.values(ConventionKind)) {
      for (const severity of Object.values(ConventionSeverity)) {
        const v = validateConvention(
          base({
            kind,
            severity,
            rules: [{ id: 'r', description: 'd', severity, expectMatch: '^a', forbidMatch: 'b$', filePattern: '\\.ts$' }],
            appliesTo: { fileGlobs: ['src/**'], languages: ['ts'] },
            tags: ['t'],
            examples: [],
          }),
        );
        expect({ kind, severity, valid: v.valid, n: v.issues.length + v.warnings.length }).toEqual({
          kind,
          severity,
          valid: true,
          n: 0,
        });
      }
    }
  });
});
