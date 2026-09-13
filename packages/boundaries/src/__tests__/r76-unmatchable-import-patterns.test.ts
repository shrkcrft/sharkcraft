/**
 * Round 12 (R12-5.2) — a specifier pattern that cannot mean what its author
 * wrote is an authoring error, never a silent ✓.
 *
 * Reproduced before: `forbiddenImports: ['@scope/pkg/']` (a trailing slash —
 * the one spelling package semantics leave literal) matched neither
 * `@scope/pkg` nor `@scope/pkg/sub`, and the dead-unit detector called it
 * RESOLVABLE (the known package `@scope/pkg` "could" match it), so `check
 * boundaries` printed `Verdict: OK — no boundary violations. ✓` at exit 0 over
 * two imports of the package. A `'!…'` entry (negation is `from`-only syntax)
 * was reported dead with "typo or retired target?" advice.
 *
 * Both are now rejected by the ONE validator every local and pack rule file
 * goes through, via the one predicate beside the matcher
 * (`importPatternDefect`). Real rule files through the real loader, a real
 * scan over real files.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  evaluateBoundaries,
  importPatternDefect,
  loadBoundaryRulesFromFile,
  matchImportPattern,
  scanImports,
  validateBoundaryRule,
  type IBoundaryRule,
} from '../index.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r76-unmatchable-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const base = { id: 't.fence', title: 'Fence', from: ['packages/t/**'] };
const T_TS = "import { a } from '@scope/pkg';\nimport { b } from '@scope/pkg/sub';\n";

describe('validateBoundaryRule rejects a specifier pattern that cannot mean what it says', () => {
  test("a trailing '/' under package semantics — forbiddenImports and exceptions[].target — naming both fixes", () => {
    const v = validateBoundaryRule({
      ...base,
      forbiddenImports: ['@scope/pkg/'],
      exceptions: [{ path: 'packages/t/**', target: '@scope/pkg/', reason: 'bridge' }],
    });
    expect(v.valid).toBe(false);
    expect(v.issues.map((i) => i.field)).toEqual(['forbiddenImports[0]', 'exceptions[0].target']);
    for (const issue of v.issues) {
      expect(issue.message).toContain("'@scope/pkg/'");
      expect(issue.message).toContain("write '@scope/pkg' (the package and every subpath");
      expect(issue.message).toContain("'@scope/pkg/**' (subpaths only)");
    }
  });

  test("a '!' entry in forbiddenImports, allowedImports and exceptions[].target — the advice is the carve-out, never 'typo?'", () => {
    const v = validateBoundaryRule({
      ...base,
      forbiddenImports: ['@scope/pkg', '!@scope/pkg/public/**'],
      allowedImports: ['!@scope/pkg/internal/**'],
      exceptions: [{ path: 'packages/t/**', target: '!@scope/pkg/x', reason: 'r' }],
    });
    expect(v.issues.map((i) => i.field)).toEqual(['forbiddenImports[1]', 'allowedImports[0]', 'exceptions[0].target']);
    for (const issue of v.issues) {
      expect(issue.message).toContain('negation is only supported in `from`');
      expect(issue.message).toContain('exceptions[{ path, target, reason }]');
      expect(issue.message).not.toContain('typo');
    }
  });

  test('an empty pattern names no import', () => {
    const v = validateBoundaryRule({ ...base, forbiddenImports: [''], allowedImports: ['react', ''] });
    expect(v.issues.map((i) => [i.field, i.message])).toEqual([
      ['forbiddenImports[0]', "'': an empty pattern names no import"],
      ['allowedImports[1]', "'': an empty pattern names no import"],
    ]);
  });

  test("a trailing '/' stays a literal where the author asked for literals: forbiddenMatch 'exact', and allowedImports", () => {
    // `'buffer/'` is a real specifier (the userland-polyfill idiom), so the
    // literal is legitimate once the rule says "match as written".
    expect(validateBoundaryRule({ ...base, forbiddenImports: ['buffer/'], forbiddenMatch: 'exact' }).issues).toEqual([]);
    expect(validateBoundaryRule({ ...base, allowedImports: ['buffer/'] }).issues).toEqual([]);
    expect(
      validateBoundaryRule({
        ...base,
        forbiddenImports: ['buffer/'],
        forbiddenMatch: 'exact',
        exceptions: [{ path: 'packages/t/**', target: 'buffer/', reason: 'r' }],
      }).issues,
    ).toEqual([]);
  });

  test('well-formed patterns stay valid', () => {
    const v = validateBoundaryRule({
      ...base,
      forbiddenImports: ['@scope/pkg', '@scope/pkg-*', '@scope/pkg/**', 'lodash/get', './x', '../y', 'packages/ui', 'node:fs'],
      allowedImports: ['react', 'react-dom/**'],
    });
    expect(v.issues).toEqual([]);
  });
});

describe('through the real boundaryFiles loader', () => {
  test('the rule lands in invalid[] with the field path — it is never registered and never evaluated', async () => {
    const root = workspace({
      'packages/t/src/t.ts': T_TS,
      'sharkcraft/boundaries.ts': `export default [
  { id: 't.trailing-slash', title: 'No pkg', from: ['packages/t/**'], forbiddenImports: ['@scope/pkg/'] },
  { id: 't.negated', title: 'No pkg but public', from: ['packages/t/**'], forbiddenImports: ['@scope/pkg', '!@scope/pkg/public/**'] },
  { id: 't.ok', title: 'Fine', from: ['packages/t/**'], forbiddenImports: ['@scope/pkg'] },
];
`,
    });
    const loaded = await loadBoundaryRulesFromFile(join(root, 'sharkcraft', 'boundaries.ts'));
    expect(loaded.rules.map((r) => r.id)).toEqual(['t.ok']);
    expect(loaded.invalid.map((i) => [i.ruleId, i.issues.map((x) => x.field)])).toEqual([
      ['t.trailing-slash', ['forbiddenImports[0]']],
      ['t.negated', ['forbiddenImports[1]']],
    ]);
  });
});

describe('defence in depth: a hand-built rule that bypasses the loader (evaluateBoundaries is exported and pure)', () => {
  const rule = (over: Partial<IBoundaryRule>): IBoundaryRule => ({ ...base, severity: 'error', ...over });

  test("the trailing-slash pattern is a dead unit that says WHY — resolvable=false even though '@scope/pkg' is a known package", () => {
    const root = workspace({ 'packages/t/src/t.ts': T_TS });
    const r = evaluateBoundaries(scanImports({ projectRoot: root }), [rule({ forbiddenImports: ['@scope/pkg/'] })], {
      knownPackages: ['@scope/pkg'],
    });
    expect(r.violations).toEqual([]);
    expect(r.coverage[0]!.forbidden[0]!.resolvable).toBe(false);
    expect(r.deadUnits.map((d) => [d.unit, d.selector, d.cause, d.reason])).toEqual([
      ['forbidden', '@scope/pkg/', 'defect', importPatternDefect('@scope/pkg/')],
    ]);
    expect(r.deadUnits[0]!.reason).not.toContain('typo or retired target');
  });

  test("a '!' allowed pattern is a defect dead unit too", () => {
    const root = workspace({ 'packages/t/src/t.ts': "import { r } from 'react';\n" });
    const r = evaluateBoundaries(scanImports({ projectRoot: root }), [rule({ allowedImports: ['react', '!react-dom/**'] })], {
      knownPackages: ['react', 'react-dom'],
    });
    expect(r.deadUnits.map((d) => [d.unit, d.selector, d.cause])).toEqual([['allowed', '!react-dom/**', 'defect']]);
  });

  test("a '?'-led pattern that matches no import is a DEAD unit — never 'resolvable' through every known package (round 12 review, R12-DOC-1)", () => {
    // The docs used to recommend '?!raw-loader!**' for an inline-loader import;
    // it never matches the common single-bang form, and the dead-unit check
    // called it resolvable (a leading '?' read as "any prefix"), so the rule
    // printed a ✓ with 0 hits and no warning.
    const root = workspace({ 'packages/t/src/t.ts': "import raw from '!raw-loader!./x.txt';\nexport const r = raw;\n" });
    const scan = scanImports({ projectRoot: root });
    const dead = evaluateBoundaries(scan, [rule({ forbiddenImports: ['?!raw-loader!**'] })], {
      knownPackages: ['react', 'raw-loader', 'lodash'],
    });
    expect(dead.violations).toEqual([]);
    expect(dead.coverage[0]!.forbidden[0]).toMatchObject({ pattern: '?!raw-loader!**', hitsAnywhere: 0, resolvable: false });
    expect(dead.deadUnits.map((d) => [d.unit, d.selector])).toEqual([['forbidden', '?!raw-loader!**']]);

    // The documented single-bang spelling reaches the import.
    const live = evaluateBoundaries(scan, [rule({ forbiddenImports: ['?raw-loader!**'] })], { knownPackages: ['react', 'raw-loader'] });
    expect(live.violations.map((v) => v.importSpecifier)).toEqual(['!raw-loader!./x.txt']);
    expect(live.deadUnits).toEqual([]);
  });

  test("a trailing-slash literal under forbiddenMatch 'exact' still matches the real 'buffer/' import", () => {
    const root = workspace({ 'packages/t/src/t.ts': "import { Buffer } from 'buffer/';\nimport { B } from 'buffer';\n" });
    const r = evaluateBoundaries(
      scanImports({ projectRoot: root }),
      [rule({ forbiddenImports: ['buffer/'], forbiddenMatch: 'exact' })],
      { knownPackages: ['buffer'] },
    );
    expect(r.violations.map((v) => [v.importSpecifier, v.matchKind])).toEqual([['buffer/', 'exact']]);
    expect(r.deadUnits).toEqual([]);
  });
});

describe('soundness — the predicate only rejects what cannot mean what it says, and its advice never narrows a fence', () => {
  /** Real specifier shapes, including the rare legal ones the predicate must reason about. */
  const CORPUS = [
    '@scope/pkg',
    '@scope/pkg/sub',
    '@scope/pkg/',
    '@scope/pkg-a/deep/thing',
    '@scope/pkgx/sub',
    'lodash',
    'lodash/get',
    'buffer/',
    'punycode/',
    'react-dom/client',
    './local',
    '../up/x',
    './',
    'packages/ui/src/index.ts',
    'node:fs',
    '!!raw-loader!./a.txt',
  ];

  test("every trailing-'/' pattern rejected under package semantics: the package spelling it recommends covers every specifier it matched", () => {
    let reached = 0;
    for (const p of ['@scope/pkg/', 'buffer/', 'punycode/', 'packages/ui/', '@scope/*/', 'a/**/']) {
      expect(importPatternDefect(p, 'package')).toBeDefined();
      const recommended = p.replace(/\/+$/, '');
      for (const s of CORPUS) {
        if (matchImportPattern(s, p, 'package') === null) continue;
        reached += 1;
        expect(matchImportPattern(s, recommended, 'package')).not.toBeNull();
      }
    }
    expect(reached).toBeGreaterThanOrEqual(3); // '@scope/pkg/', 'buffer/', 'punycode/' — the property is not vacuous
  });

  test("a '!' pattern matches no specifier that does not itself start with '!' — and '?' still reaches a literal inline-loader specifier", () => {
    for (const p of ['!@scope/pkg/public/**', '!lodash', '!**', '!./local']) {
      expect(importPatternDefect(p, 'package')).toBeDefined();
      expect(importPatternDefect(p, 'exact')).toBeDefined();
      for (const s of CORPUS.filter((x) => !x.startsWith('!'))) {
        expect(matchImportPattern(s, p, 'package')).toBeNull();
        expect(matchImportPattern(s, p, 'exact')).toBeNull();
      }
    }
    expect(importPatternDefect('?!raw-loader!**', 'exact')).toBeUndefined();
    expect(matchImportPattern('!!raw-loader!./a.txt', '?!raw-loader!**', 'exact')).toBe('exact');
  });

  test("the inline-loader rule of thumb: replace the specifier's leading '!' with '?' — single-bang AND double-bang, package mode (round 12 review, R12-DOC-1)", () => {
    for (const mode of ['package', 'exact'] as const) {
      // Single bang: '?raw-loader!**' reaches it; '?!raw-loader!**' never does.
      expect(importPatternDefect('?raw-loader!**', mode)).toBeUndefined();
      expect(matchImportPattern('!raw-loader!./x.txt', '?raw-loader!**', mode)).not.toBeNull();
      expect(matchImportPattern('!raw-loader!./x.txt', '?!raw-loader!**', mode)).toBeNull();
      // Double bang: '?!raw-loader!**'.
      expect(matchImportPattern('!!raw-loader!./a.txt', '?!raw-loader!**', mode)).not.toBeNull();
    }
  });
});
