/**
 * Round 12 (R12-5.3 / R12-5.6) — patterns that can never change a rule's
 * verdict are reported, through ONE subsumption proof beside the matcher.
 *
 * R12-5.3: `forbiddenImports: ['@scope/pkg'], allowedImports:
 * ['@scope/pkg/public/**']` carved `@scope/pkg/public/x` out in alpha.30. Under
 * package semantics the forbidden pattern covers every subpath and forbidden is
 * checked first, so the allowance went INERT — and nothing said so (it has a
 * hit anywhere, so it was not dead by reach). It is now a dead unit
 * (`cause: 'shadowed'`, coverage `allowed[].shadowedBy`). Precedence is kept:
 * allowed never re-admits — the carve-out is `exceptions[]`.
 *
 * R12-5.6: the consumer's helper expands every bare pattern to `pkg` +
 * `pkg/**`; the second is now redundant. INFO only — coverage
 * `forbidden[].subsumedBy` — never a dead unit, never a verdict change.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  boundaryPatternOverlaps,
  evaluateBoundaries,
  importPatternSubsumes,
  matchesAny,
  matchImportPattern,
  scanImports,
  type ForbiddenMatchMode,
  type IBoundaryRule,
} from '../index.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r76-shadow-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const rule = (over: Partial<IBoundaryRule>): IBoundaryRule => ({
  id: 'c.forbid-plus-allow',
  title: 'Fence',
  severity: 'error',
  from: ['packages/c/**'],
  ...over,
});

const C_TS = "import { p } from '@scope/pkg/public/x';\nimport { q } from '@scope/pkg';\n";

function run(rules: readonly IBoundaryRule[], files: Record<string, string>) {
  return evaluateBoundaries(scanImports({ projectRoot: workspace(files) }), rules);
}

describe('R12-5.3 — an allowance under a bare forbidden package is shadowed, and says so', () => {
  test("the rule-C shape: '@scope/pkg/public/**' is a shadowed dead unit; '@scope/other' keeps its 'matches no import' reason", () => {
    const r = run(
      [rule({ forbiddenImports: ['@scope/pkg'], allowedImports: ['@scope/pkg/public/**', '@scope/other'] })],
      { 'packages/c/src/c.ts': C_TS },
    );
    // Forbidden still wins — the precedence is unchanged, only made loud.
    expect(r.violations.map((v) => [v.importSpecifier, v.matchKind])).toEqual([
      ['@scope/pkg/public/x', 'subpath'],
      ['@scope/pkg', 'exact'],
    ]);
    const cov = r.coverage[0]!;
    expect(cov.allowed.map((a) => [a.pattern, a.hitsAnywhere, a.shadowedBy])).toEqual([
      ['@scope/pkg/public/**', 1, '@scope/pkg'],
      ['@scope/other', 0, undefined],
    ]);
    expect(r.deadUnits.map((d) => [d.unit, d.selector, d.cause])).toEqual([
      ['allowed', '@scope/pkg/public/**', 'shadowed'],
      ['allowed', '@scope/other', undefined],
    ]);
    expect(r.deadUnits[0]!.reason).toContain("shadowed by forbidden '@scope/pkg'");
    expect(r.deadUnits[0]!.reason).toContain("exceptions[{ path, target: '@scope/pkg/public/**', reason }]");
    // Round 13: worded by the one causes sentence (DEAD_SELECTOR_CAUSES).
    expect(r.deadUnits[1]!.reason).toContain('typo, retired target, or a target that does not exist yet (see expectEmpty)');
  });

  test("forbiddenMatch 'exact': the allowance is live — not shadowed — and admits '@scope/pkg/public/x'", () => {
    const r = run(
      [rule({ forbiddenImports: ['@scope/pkg'], forbiddenMatch: 'exact', allowedImports: ['@scope/pkg/public/**', '@scope/pkg'] })],
      { 'packages/c/src/c.ts': C_TS },
    );
    expect(r.violations.map((v) => v.importSpecifier)).toEqual(['@scope/pkg']);
    // `'@scope/pkg'` allowed next to the same literal forbidden IS shadowed even under exact.
    expect(r.coverage[0]!.allowed.map((a) => [a.pattern, a.shadowedBy])).toEqual([
      ['@scope/pkg/public/**', undefined],
      ['@scope/pkg', '@scope/pkg'],
    ]);
  });

  test('an unrelated allowance is never shadowed', () => {
    const r = run(
      [rule({ forbiddenImports: ['@scope/pkg', '@scope/pkg-*'], allowedImports: ['react', '@scope/pkgx/**', '@scope/other'] })],
      { 'packages/c/src/c.ts': "import r from 'react';\nimport { x } from '@scope/pkgx/y';\nimport { o } from '@scope/other';\n" },
    );
    expect(r.coverage[0]!.allowed.every((a) => a.shadowedBy === undefined)).toBe(true);
    expect(r.deadUnits.filter((d) => d.unit === 'allowed')).toEqual([]);
  });

  test('exceptions[] is the carve-out: it suppresses the subpath edge (and is credited, not stale)', () => {
    const r = run(
      [
        rule({
          forbiddenImports: ['@scope/pkg'],
          exceptions: [{ path: 'packages/c/**', target: '@scope/pkg/public/**', reason: 'the public API is sanctioned' }],
        }),
      ],
      { 'packages/c/src/c.ts': C_TS },
    );
    expect(r.violations.map((v) => v.importSpecifier)).toEqual(['@scope/pkg']);
    expect(r.suppressed.map((s) => [s.violation.importSpecifier, s.reason])).toEqual([['@scope/pkg/public/x', 'exception']]);
    expect(r.staleExceptions).toEqual([]);
  });
});

describe('R12-5.6 — a redundant forbidden pattern is INFO, never a dead unit', () => {
  test("the helper shape: '@scope/pkg/**' next to '@scope/pkg' is subsumedBy it; the verdict and violations are the bare pattern's", () => {
    const files = { 'packages/c/src/c.ts': "import { q } from '@scope/pkg';\nimport { s } from '@scope/pkg/sub';\n" };
    const helper = run([rule({ forbiddenImports: ['@scope/pkg', '@scope/pkg/**'] })], files);
    const bare = run([rule({ forbiddenImports: ['@scope/pkg'] })], files);
    expect(helper.coverage[0]!.forbidden.map((f) => [f.pattern, f.subsumedBy])).toEqual([
      ['@scope/pkg', undefined],
      ['@scope/pkg/**', '@scope/pkg'],
    ]);
    expect(helper.deadUnits).toEqual([]);
    const rows = (x: typeof helper) => x.violations.map((v) => [v.importSpecifier, v.matchedForbidden, v.matchKind]);
    expect(rows(helper)).toEqual(rows(bare));
    expect(rows(helper)).toEqual([
      ['@scope/pkg', '@scope/pkg', 'exact'],
      ['@scope/pkg/sub', '@scope/pkg', 'subpath'],
    ]);
  });

  test("under forbiddenMatch 'exact' the helper is NOT redundant — '@scope/pkg' no longer covers subpaths", () => {
    expect(boundaryPatternOverlaps({ forbiddenImports: ['@scope/pkg', '@scope/pkg/**'], forbiddenMatch: 'exact' }).redundantForbidden).toEqual([]);
  });

  test('of two patterns covering each other the FIRST is kept; a coverer is always a kept pattern', () => {
    const dup = boundaryPatternOverlaps({ forbiddenImports: ['@scope/pkg', '@scope/pkg'] });
    expect(dup.redundantForbidden).toEqual([{ pattern: '@scope/pkg', index: 1, by: '@scope/pkg' }]);
    // A chain: '@scope/pkg/a/**' ⊂ '@scope/pkg/a' ⊂ '@scope/pkg' — both point at the kept root.
    const chain = boundaryPatternOverlaps({ forbiddenImports: ['@scope/pkg/a/**', '@scope/pkg/a', '@scope/pkg'] });
    expect(chain.redundantForbidden.map((o) => [o.pattern, o.by])).toEqual([
      ['@scope/pkg/a/**', '@scope/pkg'],
      ['@scope/pkg/a', '@scope/pkg'],
    ]);
  });
});

describe('soundness — against the ONE matcher, over a specifier corpus', () => {
  const CORPUS = [
    '@scope/pkg',
    '@scope/pkg/',
    '@scope/pkg/sub',
    '@scope/pkg/public/x',
    '@scope/pkg/public/x/deep',
    '@scope/pkg/a',
    '@scope/pkg/a/b',
    '@scope/pkg-a',
    '@scope/pkg-a/deep/thing',
    '@scope/pkg-legacy',
    '@scope/pkgx/sub',
    '@scope/other',
    'lodash',
    'lodash/get',
    'lodash-es',
    'react',
    'react-dom/client',
    'packages/ui/src/index.ts',
    'packages/ui',
    './local',
  ];
  const PATTERNS = [
    '@scope/pkg',
    '@scope/pkg/**',
    '@scope/pkg/*',
    '@scope/pkg/public/**',
    '@scope/pkg/public/*',
    '@scope/pkg/sub',
    '@scope/pkg/a',
    '@scope/pkg-*',
    '@scope/pkg-a',
    '@scope/*',
    '@scope/**',
    '@scope/pkgx/**',
    'lodash',
    'lodash/*',
    'lodash*',
    'react',
    'react-dom/**',
    'packages/ui',
    'packages/ui/**',
    'packages/**/index.ts',
  ];
  const MODES: readonly ForbiddenMatchMode[] = ['package', 'exact'];

  test('forbidden vs forbidden: importPatternSubsumes(f, p) ⇒ every specifier p matches, f matches', () => {
    let proofs = 0;
    for (const mode of MODES) {
      for (const f of PATTERNS) {
        for (const p of PATTERNS) {
          if (f === p || !importPatternSubsumes(f, p, mode)) continue;
          proofs += 1;
          for (const s of CORPUS) {
            if (matchImportPattern(s, p, mode) !== null) expect([mode, f, p, s, matchImportPattern(s, f, mode)]).not.toContain(null);
          }
        }
      }
    }
    expect(proofs).toBeGreaterThan(10);
  });

  test('forbidden vs allowed (never widened): importPatternSubsumes(f, p, mode, exact) ⇒ every specifier matchesAny(s, [p]) admits, f forbids', () => {
    let proofs = 0;
    for (const mode of MODES) {
      for (const f of PATTERNS) {
        for (const p of PATTERNS) {
          if (!importPatternSubsumes(f, p, mode, 'exact')) continue;
          proofs += 1;
          for (const s of CORPUS) {
            if (matchesAny(s, [p])) expect([mode, f, p, s, matchImportPattern(s, f, mode)]).not.toContain(null);
          }
        }
      }
    }
    expect(proofs).toBeGreaterThan(10);
  });

  test('deleting every redundantForbidden entry never changes what the list forbids', () => {
    const lists: string[][] = [];
    for (let i = 0; i < PATTERNS.length; i += 1) {
      lists.push([PATTERNS[i]!, PATTERNS[(i * 7 + 3) % PATTERNS.length]!, PATTERNS[(i * 5 + 1) % PATTERNS.length]!, PATTERNS[i]!]);
    }
    let pruned = 0;
    for (const mode of MODES) {
      for (const list of lists) {
        const redundant = new Set(boundaryPatternOverlaps({ forbiddenImports: list, forbiddenMatch: mode }).redundantForbidden.map((o) => o.index));
        pruned += redundant.size;
        const kept = list.filter((_, i) => !redundant.has(i));
        expect(kept.length).toBeGreaterThan(0);
        for (const s of CORPUS) {
          const before = list.some((p) => matchImportPattern(s, p, mode) !== null);
          const after = kept.some((p) => matchImportPattern(s, p, mode) !== null);
          expect([mode, list.join(' '), s, after]).toEqual([mode, list.join(' '), s, before]);
        }
      }
    }
    expect(pruned).toBeGreaterThan(10);
  });
});
