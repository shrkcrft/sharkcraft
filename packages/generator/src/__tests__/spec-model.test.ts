import { describe, expect, test } from 'bun:test';
import { deriveSpecJson } from '../spec/spec-derive.ts';
import { splitSpecMd } from '../spec/spec-frontmatter.ts';
import { buildSpecId, normalizeSlug } from '../spec/spec-id.ts';
import { validateSpecStructural } from '../spec/spec-model.ts';

const VALID_MD = `---
schema: sharkcraft.spec/v1
id: 2026-05-17-valid-spec
slug: valid-spec
title: Valid spec
status: draft
createdAt: 2026-05-17T08:00:00.000Z
updatedAt: 2026-05-17T08:00:00.000Z

intent: |
  Add a thing.

motivation: |
  Because the thing is needed.

acceptanceCriteria:
  - id: ac-1
    text: Tests pass.
    verifiedBy:
      - tests

affectedAreas:
  files:
  packages:
  layers:

relevantRules:
relevantKnowledge:
relevantPaths:

proposedTemplates:

risks:

outOfScope:

externalLinks:
  issue: null
  pr: null

boundariesCheck:
  predicted:

verificationCommands:
---

# Valid spec
`;

describe('spec-model validation', () => {
  test('accepts a well-formed spec', () => {
    const v = deriveOk(VALID_MD);
    const issues = validateSpecStructural(v.spec, v.body);
    expect(issues.errors).toEqual([]);
  });

  test('flags missing intent / motivation / acceptance', () => {
    const md = VALID_MD.replace(/intent: \|\n.*\n/, 'intent: ""\n')
      .replace(/motivation: \|\n.*\n/, 'motivation: ""\n')
      .replace(/acceptanceCriteria:[\s\S]*?\n\naffected/, 'acceptanceCriteria:\n\naffected');
    const v = deriveOk(md);
    const issues = validateSpecStructural(v.spec, v.body);
    const codes = issues.errors.map((e) => e.code);
    expect(codes).toContain('missing-intent');
    expect(codes).toContain('missing-motivation');
    expect(codes).toContain('missing-acceptance-criteria');
  });

  test('flags duplicate acceptance ids', () => {
    const md = VALID_MD.replace(
      'acceptanceCriteria:\n  - id: ac-1\n    text: Tests pass.\n    verifiedBy:\n      - tests\n',
      [
        'acceptanceCriteria:',
        '  - id: ac-1',
        '    text: First',
        '    verifiedBy:',
        '      - tests',
        '  - id: ac-1',
        '    text: Second',
        '    verifiedBy:',
        '      - tests',
        '',
      ].join('\n'),
    );
    const v = deriveOk(md);
    const issues = validateSpecStructural(v.spec, v.body);
    expect(issues.errors.map((e) => e.code)).toContain('acceptance-duplicate-id');
  });

  test('warns when body exceeds configured byte cap', () => {
    const longBody = 'x'.repeat(50);
    const v = deriveOk(VALID_MD);
    const issues = validateSpecStructural(v.spec, longBody, { bodyMaxBytes: 10 });
    expect(issues.warnings.map((w) => w.code)).toContain('body-too-long');
  });
});

describe('spec-id', () => {
  test('builds an id from a title', () => {
    const built = buildSpecId({ title: 'Add Spec Verb!', date: '2026-05-17' });
    expect(built.id).toBe('2026-05-17-add-spec-verb');
    expect(built.slug).toBe('add-spec-verb');
  });

  test('resolves conflicts with numeric suffixes', () => {
    const built = buildSpecId({
      title: 'demo',
      date: '2026-05-17',
      existingIds: ['2026-05-17-demo', '2026-05-17-demo-2'],
    });
    expect(built.id).toBe('2026-05-17-demo-3');
  });

  test('normalizes slugs', () => {
    expect(normalizeSlug('Hello, World!')).toBe('hello-world');
    expect(normalizeSlug('---weird---')).toBe('weird');
    expect(normalizeSlug('')).toBe('spec');
  });
});

function deriveOk(md: string) {
  const split = splitSpecMd(md);
  if (!split.ok) throw split.error;
  const derived = deriveSpecJson(split.value);
  if (!derived.ok) throw derived.error;
  return { spec: derived.value, body: split.value.body };
}
