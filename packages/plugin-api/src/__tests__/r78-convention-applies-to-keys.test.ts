/**
 * r78 — round 15 (15.1): `appliesTo` is a CLOSED set of filters.
 *
 * `validateConvention` shape-checked the five known keys and never looked at
 * any other: `appliesTo: { fileGlob: ['lib/**'] }` validated clean and the
 * convention applied to EVERY file (the typo'd filter was ignored). An unknown
 * key is now an ERROR with a did-you-mean through the one scorer
 * (`nearestIds`), so the convention is rejected through the round-12 channel.
 * `constructKinds` has no deterministic authority and is RESERVED: it loads
 * with a warning that says so. A malformed `fileGlobs` list (bare `!`, `!!x`,
 * negations only) is the load error it is on every other plane.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConventionAppliesToFilter } from '../convention-applies-to-filter.ts';
import { validateConvention } from '../convention.ts';

function withAppliesTo(appliesTo: unknown): Record<string, unknown> {
  return { id: 'c.x', title: 'X', kind: 'naming', severity: 'warning', rules: [], appliesTo };
}

describe('an unknown appliesTo key is an ERROR with a did-you-mean', () => {
  test('the report shape: `fileGlob` (a typo that used to widen the convention to every file)', () => {
    const v = validateConvention(withAppliesTo({ fileGlob: ['lib/**'] }));
    expect(v.valid).toBe(false);
    expect(v.issues.map((i) => i.field)).toEqual(['appliesTo.fileGlob']);
    expect(v.issues[0]!.message).toContain('is not an appliesTo filter');
    expect(v.issues[0]!.message).toContain('did you mean "fileGlobs"?');
  });

  test('`profileId` suggests `profileIds`; a key near nothing names the filters and guesses nothing', () => {
    const near = validateConvention(withAppliesTo({ profileId: ['has-typescript'] }));
    expect(near.issues[0]!.message).toContain('did you mean "profileIds"?');
    const far = validateConvention(withAppliesTo({ zzqqxx: ['x'] }));
    expect(far.valid).toBe(false);
    expect(far.issues[0]!.message).toContain('filters: languages, frameworks, fileGlobs, constructKinds, profileIds');
    expect(far.issues[0]!.message).not.toContain('did you mean');
  });

  test('a case-only slip (`FileGlobs`) names the filter it meant — the scorer skips case-equal ids, so it is named first', () => {
    const v = validateConvention(withAppliesTo({ FileGlobs: ['src/**'] }));
    expect(v.valid).toBe(false);
    expect(v.issues.map((i) => i.field)).toEqual(['appliesTo.FileGlobs']);
    expect(v.issues[0]!.message).toContain('did you mean "fileGlobs"?');
  });

  test('two unknown keys are two issues; a known key beside them is not one', () => {
    const v = validateConvention(withAppliesTo({ profileId: ['a'], bogus: ['x'], fileGlobs: ['src/**'] }));
    expect(v.issues.map((i) => i.field).sort()).toEqual(['appliesTo.bogus', 'appliesTo.profileId']);
  });
});

describe('constructKinds is RESERVED — loaded, warned about, never evaluated', () => {
  test('a non-empty list is a warning naming the reservation; the convention stays valid', () => {
    const v = validateConvention(withAppliesTo({ constructKinds: ['component'] }));
    expect(v.valid).toBe(true);
    expect(v.issues).toEqual([]);
    expect(v.warnings).toEqual([
      {
        field: 'appliesTo.constructKinds',
        message: 'appliesTo.constructKinds is reserved and not evaluated — the convention applies regardless',
      },
    ]);
  });

  test('an empty list imposes nothing and says nothing', () => {
    expect(validateConvention(withAppliesTo({ constructKinds: [] })).warnings).toEqual([]);
  });
});

describe('fileGlobs goes through the one glob-list parser', () => {
  test('a bare `!`, a double negation and a negation-only list are errors', () => {
    for (const fileGlobs of [['src/**', '!'], ['!!src/a.ts'], ['!src/b.ts']]) {
      const v = validateConvention(withAppliesTo({ fileGlobs }));
      expect({ fileGlobs, valid: v.valid, fields: v.issues.map((i) => i.field) }).toEqual({
        fileGlobs,
        valid: false,
        fields: ['appliesTo.fileGlobs'],
      });
    }
  });

  test('an inclusion with a negation is well formed', () => {
    const v = validateConvention(withAppliesTo({ fileGlobs: ['src/**', '!src/gen/**'] }));
    expect({ valid: v.valid, issues: v.issues, warnings: v.warnings }).toEqual({ valid: true, issues: [], warnings: [] });
  });
});

describe('the vocabulary is ONE closed set', () => {
  test('ConventionAppliesToFilter ≡ the keys IConventionAppliesTo declares (source text — a new field cannot hide)', () => {
    const text = readFileSync(join(import.meta.dir, '..', 'convention.ts'), 'utf8');
    const start = text.indexOf('export interface IConventionAppliesTo {');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = text.slice(start, text.indexOf('\n}', start));
    const declared = [...body.matchAll(/readonly (\w+)\??:/g)].map((m) => m[1]!).sort();
    expect(declared).toEqual([...Object.values(ConventionAppliesToFilter)].sort());
  });

  test('property: every declared filter with a string list validates (constructKinds only warns)', () => {
    for (const filter of Object.values(ConventionAppliesToFilter)) {
      const v = validateConvention(withAppliesTo({ [filter]: ['x/**'] }));
      expect({ filter, valid: v.valid, issues: v.issues.length }).toEqual({ filter, valid: true, issues: 0 });
      expect({ filter, warnings: v.warnings.length }).toEqual({
        filter,
        warnings: filter === ConventionAppliesToFilter.ConstructKinds ? 1 : 0,
      });
    }
  });
});
