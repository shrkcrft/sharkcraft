/**
 * Round 12 (12.2a) — ONE scope authority for "is path P selected by glob list G".
 *
 * Every gate plane compiled a `!` entry to a literal glob that no path matches
 * and OR-ed it into the list, so a negation the author wrote was silently
 * ignored: the spec files, drafts and hand-written files it named were measured
 * all along. The boundary plane alone honoured `!`, through a parser of its own.
 *
 * Now `parseGlobList` (core) is the one parser, `globListSelects` the one scope
 * test (an inclusion glob matches, no negation of THE SAME list does), walks are
 * positive-only unions, and per-list selection happens after the walk — so one
 * rule's negation can never remove a file from another rule's scope. Real trees
 * on disk, the real reader.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseGlobList } from '@shrkcrft/core';
import { countMatchesPerGlob, globListSelects, globListWalkGlobs, measureGlobList } from '../scan/glob.ts';
import { MAX_SCAN_FILE_BYTES, readMatchingFiles } from '../util/walk-files.ts';
import { readSelectedFiles } from '../util/read-selected-files.ts';
import { unreadEntryMatches, unreadMatching } from '../util/read-scope-coverage.ts';
import { globListUnits } from '../util/dead-glob-units.ts';
import { UnreadFileReason } from '../util/unread-file-reason.ts';
import { inspectSource } from '../extract/inspect-source.ts';
import { validateBoundaryRule } from '../model/boundary-rule.ts';
import { boundaryRuleScope } from '../model/boundary-rule-scope.ts';

const LIST = ['src/**/*.ts', '!src/**/*.spec.ts'];

const roots: string[] = [];
const locked: string[] = [];
afterAll(() => {
  for (const d of locked) chmodSync(d, 0o755);
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r76-glob-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

/** A real file just over the one reader's cap. */
const overCap = (body: string): string => `${body}\n// ${'x'.repeat(MAX_SCAN_FILE_BYTES + 16)}\n`;

describe('the one parser and the one scope test', () => {
  test('parseGlobList splits inclusion globs from negations (the `!` stripped)', () => {
    expect(parseGlobList(LIST)).toEqual({ include: ['src/**/*.ts'], exclude: ['src/**/*.spec.ts'] });
  });

  test('globListSelects: an inclusion glob matches and no negation does', () => {
    expect(globListSelects('src/a.ts', LIST)).toBe(true);
    expect(globListSelects('src/deep/a.spec.ts', LIST)).toBe(false);
    expect(globListSelects('lib/a.ts', LIST)).toBe(false);
  });

  test('order-independent: the negation first gives the same answers, and nothing re-includes', () => {
    const reversed = ['!src/**/*.spec.ts', 'src/**/*.ts'];
    for (const p of ['src/a.ts', 'src/a.spec.ts', 'src/x/y.spec.ts', 'lib/z.ts']) {
      expect({ p, selected: globListSelects(p, reversed) }).toEqual({ p, selected: globListSelects(p, LIST) });
    }
    // Not gitignore semantics: a later inclusion glob never re-includes what a negation removed.
    expect(globListSelects('src/a.spec.ts', [...LIST, 'src/a.spec.ts'])).toBe(false);
  });

  test('a walk reads the inclusion globs only', () => {
    expect(globListWalkGlobs(LIST)).toEqual(['src/**/*.ts']);
    expect(globListWalkGlobs(['a/**', 'b/*.ts'])).toEqual(['a/**', 'b/*.ts']);
  });

  test('a list is memoised by its text, never by array identity — a list mutated after use is re-read', () => {
    const list = ['src/**/*.ts'];
    expect(globListSelects('src/a.spec.ts', list)).toBe(true);
    list.push('!src/**/*.spec.ts');
    expect(globListSelects('src/a.spec.ts', list)).toBe(false);
  });
});

describe('per-glob measure — the authority the dead-unit decision reads', () => {
  const paths = ['src/a.ts', 'src/b.ts', 'src/a.spec.ts', 'lib/c.spec.ts'];

  test('an inclusion glob counts what survives; a negation counts what it excludes from its OWN list', () => {
    expect(measureGlobList(paths, LIST)).toEqual([
      { glob: 'src/**/*.ts', negation: false, matched: 3, effective: 2 },
      // lib/c.spec.ts is outside this list's positive set, so it was never "excluded".
      { glob: '!src/**/*.spec.ts', negation: true, matched: 1, effective: 1 },
    ]);
    expect([...countMatchesPerGlob(paths, LIST)]).toEqual([
      ['src/**/*.ts', 2],
      ['!src/**/*.spec.ts', 1],
    ]);
  });

  test('PROPERTY: a path is counted under some inclusion glob iff globListSelects selects it', () => {
    const corpus = ['src/a.ts', 'src/a.spec.ts', 'src/x/y.ts', 'src/x/y.spec.ts', 'lib/z.ts', 'lib/z.spec.ts', 'README.md'];
    const lists = [
      LIST,
      ['!src/**/*.spec.ts', 'src/**/*.ts', 'lib/*.ts'],
      ['**/*.ts', '!lib/**', '!**/y.ts'],
      ['src/**', 'lib/*.ts'],
    ];
    for (const globs of lists) {
      for (const p of corpus) {
        const counted = measureGlobList([p], globs).some((m) => !m.negation && m.effective > 0);
        expect({ p, globs, counted }).toEqual({ p, globs, counted: globListSelects(p, globs) });
      }
    }
  });
});

describe('the reader — positive walks, per-list selection', () => {
  test("UNION ISOLATION: one list's negation never removes a file from another list's scope", () => {
    const root = tree({ 'src/a.ts': 'export const A = 1;\n', 'src/a.spec.ts': 'export const S = 1;\n' });
    const B = ['src/**/*.spec.ts'];
    // The union walk is positive-only: A's `!` does not delete the spec file from it.
    expect([...readMatchingFiles(root, [...LIST, ...B]).files.keys()].sort()).toEqual(['src/a.spec.ts', 'src/a.ts']);
    expect(globListSelects('src/a.spec.ts', B)).toBe(true);
    expect([...readSelectedFiles(root, LIST).files.keys()]).toEqual(['src/a.ts']);
    expect([...readSelectedFiles(root, B).files.keys()]).toEqual(['src/a.spec.ts']);
  });

  test('an over-cap file the list excludes is never unread for it — the rule is not PARTIAL', () => {
    const root = tree({ 'src/a.ts': 'export const A = 1;\n', 'src/big.spec.ts': overCap('export const BIG = 1;') });
    const positive = readMatchingFiles(root, LIST);
    expect(positive.unread.map((u) => u.path)).toEqual(['src/big.spec.ts']);
    expect(unreadMatching(positive.unread, LIST)).toEqual([]);
    expect(readSelectedFiles(root, LIST).unread).toEqual([]);
    const insp = inspectSource(root, { files: LIST, extract: 'export-names' });
    expect({ files: insp.filesScanned, unread: insp.unread, ids: insp.ids }).toEqual({ files: 1, unread: [], ids: ['A'] });
    // Without the negation the file IS in scope and unread — the round-11 contract is unchanged.
    expect(inspectSource(root, { files: ['src/**/*.ts'], extract: 'export-names' }).unread.map((u) => u.path)).toEqual([
      'src/big.spec.ts',
    ]);
  });

  test('an unlistable directory wholly covered by a negation is not in scope; a partially covered one still is', () => {
    const dir = { path: 'src/locked/', reason: UnreadFileReason.UnreadableDirectory };
    expect(unreadEntryMatches(dir, ['src/**/*.ts'])).toBe(true);
    expect(unreadEntryMatches(dir, ['src/**/*.ts', '!src/locked/**'])).toBe(false);
    expect(unreadEntryMatches(dir, ['src/**/*.ts', '!src/locked/*.spec.ts'])).toBe(true);
  });

  test('…the same on a REAL directory the walk cannot list', () => {
    const root = tree({ 'src/a.ts': 'export const A = 1;\n', 'src/locked/b.ts': 'export const B = 1;\n' });
    const dir = join(root, 'src', 'locked');
    chmodSync(dir, 0o000);
    locked.push(dir);
    let listable = true;
    try {
      readdirSync(dir);
    } catch {
      listable = false;
    }
    // Running as root keeps the directory listable; the entry-level case above
    // then carries the rule, and there is nothing unread here to assert on.
    if (listable) return;
    expect(readSelectedFiles(root, ['src/**/*.ts']).unread.map((u) => u.path)).toEqual(['src/locked/']);
    expect(readSelectedFiles(root, ['src/**/*.ts', '!src/locked/**']).unread).toEqual([]);
    expect(readSelectedFiles(root, ['src/**/*.ts', '!src/locked/*.spec.ts']).unread.map((u) => u.path)).toEqual([
      'src/locked/',
    ]);
  });
});

describe('the one dead-unit decision (globListUnits)', () => {
  const walked = ['src/a.ts', 'src/b.ts', 'src/a.spec.ts'];

  test('a load-bearing negation is alive, reported with what it excludes', () => {
    const units = globListUnits(walked, [], LIST);
    expect(units.dead).toEqual([]);
    expect(units.negations).toEqual([{ glob: '!src/**/*.spec.ts', excludes: 1 }]);
    expect(units.checked).toBe(2);
  });

  test('a negation that excludes nothing is dead — worded "excludes nothing", never "matched 0 files"', () => {
    expect(globListUnits(walked, [], ['src/**/*.ts', '!src/nowhere/**']).dead).toEqual([
      {
        glob: '!src/nowhere/**',
        negation: true,
        matched: 3,
        reason: 'excludes nothing — none of the 3 file(s) the other globs select match it',
      },
    ]);
  });

  test('an inclusion glob is dead when it selects nothing that survives — with the reason that says which', () => {
    expect(globListUnits(walked, [], ['src/**/*.ts', 'src/a.spec.ts', '!**/*.spec.ts']).dead).toEqual([
      { glob: 'src/a.spec.ts', negation: false, matched: 1, reason: "matches only files the list's negations exclude (1)" },
    ]);
    expect(globListUnits(walked, [], ['src/**/*.ts', 'gone/*.ts']).dead).toEqual([
      { glob: 'gone/*.ts', negation: false, matched: 0, reason: 'matched 0 files' },
    ]);
  });

  test('a negation whose only excluded file is unread (over the cap) is alive', () => {
    const unread = [{ path: 'src/big.spec.ts', reason: UnreadFileReason.OverReadCap, bytes: MAX_SCAN_FILE_BYTES + 1 }];
    const units = globListUnits(['src/a.ts'], unread, LIST);
    expect(units.dead).toEqual([]);
    expect(units.negations).toEqual([{ glob: '!src/**/*.spec.ts', excludes: 1 }]);
  });

  test('an inclusion glob whose only match is an EXCLUDED unread file is dead, and says it matched (never "0 files")', () => {
    const unread = [{ path: 'src/big.spec.ts', reason: UnreadFileReason.OverReadCap, bytes: MAX_SCAN_FILE_BYTES + 1 }];
    expect(globListUnits(['src/a.ts'], unread, ['src/a.ts', 'src/big.spec.ts', '!**/*.spec.ts']).dead).toEqual([
      {
        glob: 'src/big.spec.ts',
        negation: false,
        matched: 1,
        reason: "matches only files the list's negations exclude (1)",
      },
    ]);
  });

  test("a union walk wider than the list never counts another list's files as excluded", () => {
    expect(globListUnits([...walked, 'lib/z.spec.ts'], [], LIST).negations).toEqual([
      { glob: '!src/**/*.spec.ts', excludes: 1 },
    ]);
  });
});

describe('boundary plane: the same parser, its EXEMPTION semantics kept', () => {
  test('`from` is split by the one parser; a negation there is an exemption, not an exclusion', () => {
    const scope = boundaryRuleScope({ id: 'r', title: 'r', from: ['src/**', '!src/**/*.spec.ts'], forbiddenImports: ['x'] });
    expect(scope.include).toEqual(['src/**']);
    expect(scope.exemptions).toEqual([{ glob: 'src/**/*.spec.ts', origin: 'from-negation' }]);
  });

  test('a bare "!", a "!!x" and an only-exemptions `from` fail validation, as does a "!" in exemptFiles', () => {
    const base = { id: 'r', title: 'r', forbiddenImports: ['x'] };
    const issues = (v: unknown): string[] => validateBoundaryRule(v).issues.map((i) => `${i.field}: ${i.message}`);
    expect(issues({ ...base, from: ['src/**', '!'] })).toEqual(['from: from "!" is not a glob (an empty negation)']);
    expect(issues({ ...base, from: ['src/**', '!!src/x.ts'] })).toEqual([
      'from: from double negation "!!src/x.ts" is not supported — write the inclusion glob',
    ]);
    // The pre-round-12 wording for this shape, unchanged.
    expect(issues({ ...base, from: ['!src/**'] })).toEqual([
      'from: from needs at least one inclusion glob (entries starting with "!" are exemptions)',
    ]);
    expect(issues({ ...base, from: ['src/**'], exemptFiles: ['!src/keep.ts'] })).toEqual([
      'exemptFiles: exemptFiles "!src/keep.ts": an exemption list takes plain globs — "!" here would mean "exempt everything else"',
    ]);
    expect(issues({ ...base, from: ['src/**', '!src/**/*.spec.ts'] })).toEqual([]);
  });
});
