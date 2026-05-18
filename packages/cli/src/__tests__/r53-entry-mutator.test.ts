/**
 * Shared entry-aware mutator primitives.
 *
 * Locks in: findEntryRange survives nested braces / string literals,
 * upsertScalarField replaces vs. inserts as appropriate,
 * removeStringFromArray removes by value preserving formatting,
 * removeArrayEntries supports custom predicates.
 */
import { describe, expect, test } from 'bun:test';
import {
  findEntryRange,
  entryHasField,
  insertField,
  replaceScalarField,
  upsertScalarField,
  removeArrayEntries,
  removeStringFromArray,
  splitTopLevelCommas,
} from '../asset-preview/entry-mutator.ts';

const BODY = `import { defineKnowledge } from '@shrkcrft/knowledge';

export default defineKnowledge([
  {
    id: 'team.style',
    title: 'Team style',
    type: 'rule',
    priority: 'high',
    content: 'Use Result + AppErrorImpl on public APIs.',
    related: [
      'repo.discovery.read-examples-first',
      'typescript.files.one-export',
    ],
    references: [
      { kind: 'symbol', symbol: 'OldName', path: 'packages/x/y.ts' },
      { kind: 'file', path: 'packages/z/q.ts' },
    ],
  },
  {
    id: 'team.review',
    title: 'Team review',
    type: 'documentation',
    content: 'Two reviewers required.',
  },
]);
`;

describe('findEntryRange', () => {
  test('finds an entry by id and returns its `{...}` range', () => {
    const r = findEntryRange(BODY, 'team.style');
    expect(r).not.toBeNull();
    expect(BODY[r!.open]).toBe('{');
    expect(BODY[r!.close]).toBe('}');
    expect(BODY.slice(r!.open, r!.close + 1)).toContain("id: 'team.style'");
  });

  test('matches the correct entry when multiple have similar ids', () => {
    const r = findEntryRange(BODY, 'team.review');
    expect(r).not.toBeNull();
    const slice = BODY.slice(r!.open, r!.close + 1);
    expect(slice).toContain("id: 'team.review'");
    expect(slice).not.toContain("id: 'team.style'");
  });

  test('returns null for an unknown id', () => {
    expect(findEntryRange(BODY, 'team.nonexistent')).toBeNull();
  });
});

describe('entryHasField', () => {
  test('detects existing top-level fields', () => {
    const r = findEntryRange(BODY, 'team.style')!;
    expect(entryHasField(BODY, r, 'title')).toBe(true);
    expect(entryHasField(BODY, r, 'priority')).toBe(true);
  });

  test('returns false for absent fields', () => {
    const r = findEntryRange(BODY, 'team.review')!;
    expect(entryHasField(BODY, r, 'actionHints')).toBe(false);
  });
});

describe('insertField', () => {
  test('inserts a fragment before the closing `}`', () => {
    const r = findEntryRange(BODY, 'team.review')!;
    const next = insertField(BODY, r, "summary: 'A summary',");
    expect(next).toContain("summary: 'A summary'");
    // Inserted inside the team.review entry, not after it.
    const reviewIdx = next.indexOf("id: 'team.review'");
    const summaryIdx = next.indexOf("summary: 'A summary'");
    expect(summaryIdx).toBeGreaterThan(reviewIdx);
  });
});

describe('replaceScalarField', () => {
  test('replaces a single-line scalar value', () => {
    const r = findEntryRange(BODY, 'team.style')!;
    const next = replaceScalarField(BODY, r, 'priority', "'critical'");
    expect(next).not.toBeNull();
    expect(next!).toContain("priority: 'critical'");
    expect(next!).not.toContain("priority: 'high'");
  });

  test('returns null when the field is absent', () => {
    const r = findEntryRange(BODY, 'team.review')!;
    expect(replaceScalarField(BODY, r, 'priority', "'medium'")).toBeNull();
  });
});

describe('upsertScalarField', () => {
  test('replaces when the field is present', () => {
    const r = findEntryRange(BODY, 'team.style')!;
    const result = upsertScalarField(BODY, r, 'priority', "'critical'", "priority: 'critical',");
    expect(result.mode).toBe('replace');
    expect(result.body).toContain("priority: 'critical'");
  });

  test('inserts when the field is absent', () => {
    const r = findEntryRange(BODY, 'team.review')!;
    const result = upsertScalarField(BODY, r, 'priority', "'medium'", "priority: 'medium',");
    expect(result.mode).toBe('insert');
    expect(result.body).toContain("priority: 'medium'");
  });
});

describe('removeStringFromArray', () => {
  test('removes a matching element from a top-level string array', () => {
    const r = findEntryRange(BODY, 'team.style')!;
    const result = removeStringFromArray(BODY, r, 'related', 'typescript.files.one-export');
    expect(result).not.toBeNull();
    expect(result!.removedCount).toBe(1);
    expect(result!.body).toContain('repo.discovery.read-examples-first');
    expect(result!.body).not.toContain('typescript.files.one-export');
  });

  test('returns removedCount=0 when the element is absent (idempotent)', () => {
    const r = findEntryRange(BODY, 'team.style')!;
    const result = removeStringFromArray(BODY, r, 'related', 'totally.absent.id');
    expect(result).not.toBeNull();
    expect(result!.removedCount).toBe(0);
    expect(result!.body).toBe(BODY);
  });

  test('returns null when the array field is absent', () => {
    const r = findEntryRange(BODY, 'team.review')!;
    expect(removeStringFromArray(BODY, r, 'related', 'anything')).toBeNull();
  });
});

describe('removeArrayEntries with custom predicate', () => {
  test('removes an object element matching a predicate', () => {
    const r = findEntryRange(BODY, 'team.style')!;
    const result = removeArrayEntries(BODY, r, 'references', (el) =>
      /kind:\s*'symbol'/.test(el) && /symbol:\s*'OldName'/.test(el),
    );
    expect(result).not.toBeNull();
    expect(result!.removedCount).toBe(1);
    expect(result!.body).not.toContain("symbol: 'OldName'");
    // The other reference must survive.
    expect(result!.body).toContain("path: 'packages/z/q.ts'");
  });
});

describe('splitTopLevelCommas', () => {
  test('splits at top level only, respecting nested brackets', () => {
    const parts = splitTopLevelCommas("'a', { x: 1, y: 2 }, ['b', 'c'], 'd'");
    expect(parts).toHaveLength(4);
    expect(parts[1]!.trim()).toBe('{ x: 1, y: 2 }');
    expect(parts[2]!.trim()).toBe("['b', 'c']");
  });

  test('respects strings with commas', () => {
    const parts = splitTopLevelCommas("'a, with comma', 'b'");
    expect(parts).toHaveLength(2);
    expect(parts[0]!.trim()).toBe("'a, with comma'");
  });
});
