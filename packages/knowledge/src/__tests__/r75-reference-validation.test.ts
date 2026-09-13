/**
 * Round 11, 4.1(6) — a malformed reference is a validation issue at load time,
 * not a silent `unknown` row the stale-check shrugs at. Each new issue code
 * fires on its malformed input and is silent on valid input.
 */
import { describe, expect, test } from 'bun:test';
import type { IKnowledgeEntry } from '../model/knowledge-entry.ts';
import { validateKnowledgeEntries } from '../validate/validate-knowledge-entries.ts';

function entry(extra: Record<string, unknown>): IKnowledgeEntry {
  return {
    id: 'k.x',
    title: 'X',
    type: 'technical',
    priority: 'medium',
    scope: [],
    tags: [],
    appliesWhen: [],
    content: 'x',
    ...extra,
  } as unknown as IKnowledgeEntry;
}

const NEW_CODES = new Set([
  'invalid-reference',
  'invalid-reference-pattern',
  'invalid-reference-count',
  'invalid-verified-on',
]);

function codes(extra: Record<string, unknown>): { code: string; severity: string }[] {
  return validateKnowledgeEntries([entry(extra)])
    .issues.filter((i) => NEW_CODES.has(i.code))
    .map((i) => ({ code: i.code, severity: i.severity }));
}

describe('valid references and dates raise nothing', () => {
  test('every assertion form, well-formed', () => {
    expect(
      codes({
        verifiedOn: '2026-09-11',
        references: [
          { kind: 'file', path: 'src/a.ts', contains: 'export', scan: 'code' },
          { kind: 'file', path: 'src/a.ts', matches: '^export (const|function) ' },
          { kind: 'symbol', symbol: 'Foo.bar', path: 'src/foo.ts' },
          { kind: 'directory', path: 'src', count: { source: { files: ['src/*.ts'], pattern: '(x)' }, expected: 3 } },
          { kind: 'command', command: 'shrk doctor' },
          { kind: 'url', id: 'https://example.com' },
        ],
      }),
    ).toEqual([]);
  });
});

describe('each malformed shape has its code', () => {
  test('an unknown kind is an error', () => {
    expect(codes({ references: [{ kind: 'bogus', path: 'x' }] })).toEqual([
      { code: 'invalid-reference', severity: 'error' },
    ]);
  });

  test('a missing required field is a warning (the check can only say unknown)', () => {
    expect(codes({ references: [{ kind: 'file' }] })).toEqual([{ code: 'invalid-reference', severity: 'warning' }]);
    expect(codes({ references: [{ kind: 'symbol', path: 'src/a.ts' }] })).toEqual([
      { code: 'invalid-reference', severity: 'warning' },
    ]);
  });

  test('contains / matches on a kind with no content is an error', () => {
    expect(codes({ references: [{ kind: 'directory', path: 'src', contains: 'x' }] })).toEqual([
      { code: 'invalid-reference', severity: 'error' },
    ]);
    expect(codes({ references: [{ kind: 'template', id: 't', matches: 'x' }] })).toEqual([
      { code: 'invalid-reference', severity: 'error' },
    ]);
  });

  test('a regex that does not compile', () => {
    expect(codes({ references: [{ kind: 'file', path: 'a.ts', matches: '(' }] })).toEqual([
      { code: 'invalid-reference-pattern', severity: 'error' },
    ]);
  });

  test('an unknown scan zone', () => {
    expect(codes({ references: [{ kind: 'file', path: 'a.ts', contains: 'x', scan: 'bogus' }] })).toEqual([
      { code: 'invalid-reference', severity: 'error' },
    ]);
  });

  test('a malformed count', () => {
    const bad = (count: unknown): { code: string; severity: string }[] =>
      codes({ references: [{ kind: 'directory', path: 'src', count }] });
    expect(bad({ source: { files: ['a/*.ts'], pattern: '(x)' }, expected: -1 })).toEqual([
      { code: 'invalid-reference-count', severity: 'error' },
    ]);
    expect(bad({ source: { files: ['a/*.ts'], pattern: '(x)' }, expected: 1, measure: 'lines' })).toEqual([
      { code: 'invalid-reference-count', severity: 'error' },
    ]);
    expect(bad({ source: { $use: 'handlers' }, expected: 1 })).toEqual([
      { code: 'invalid-reference-count', severity: 'error' },
    ]);
    expect(bad({ source: { pattern: '(x)' }, expected: 1 })).toEqual([
      { code: 'invalid-reference-count', severity: 'error' },
    ]);
  });

  test('a verifiedOn that is not a real YYYY-MM-DD date', () => {
    for (const d of ['2026-02-30', '26-01-01', 'yesterday']) {
      expect(codes({ verifiedOn: d })).toEqual([{ code: 'invalid-verified-on', severity: 'error' }]);
    }
  });
});
