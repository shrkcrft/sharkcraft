/**
 * Round 11 (4.4) — exemptions and sanctioned exceptions, marked, never dropped.
 *
 * Teams that could not express "production code under X must not import Y —
 * but its tests may, and these two adjudicated edges are allowed" deleted the
 * boundary rule and hand-wrote a scanner. The model now has `exemptFiles`,
 * `excludeTests`, `!` exemptions in `from`, and `exceptions[{path,target,
 * reason}]` — with a stale exception FAILING the run so the list cannot rot.
 * Every reader of "is file F in rule R's scope" uses one authority.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  boundaryRuleCovers,
  evaluateBoundaries,
  loadBoundaryRulesFromFile,
  scanImports,
  validateBoundaryRule,
  type IBoundaryRule,
} from '../index.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-exempt-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const FILES = {
  'src/app/page.ts': "import { F } from '@scope/forbidden';\nimport { G } from '@scope/other';\n",
  'src/app/page.spec.ts': "import { F } from '@scope/forbidden';\n",
  'src/app/__tests__/helper.ts': "import { F } from '@scope/forbidden';\n",
  'src/app/legacy.ts': "import { F } from '@scope/forbidden';\n",
};

const base: IBoundaryRule = {
  id: 'app.no-forbidden',
  title: 'No forbidden',
  severity: 'error',
  from: ['src/app/**'],
  forbiddenImports: ['@scope/forbidden', '@scope/other'],
};

function run(rules: readonly IBoundaryRule[]) {
  const root = workspace(FILES);
  return evaluateBoundaries(scanImports({ projectRoot: root }), rules);
}

const reported = (r: ReturnType<typeof run>): string[] =>
  r.violations.map((v) => `${v.file}→${v.importSpecifier}`).sort();

describe('exemptions are marked suppressed, counted, never dropped', () => {
  test('a violation in an exemptFiles file goes to suppressed[] and does not fail', () => {
    const r = run([{ ...base, exemptFiles: ['src/app/legacy.ts'] }]);
    expect(reported(r)).not.toContain('src/app/legacy.ts→@scope/forbidden');
    expect(r.suppressed.map((s) => [s.violation.file, s.reason, s.glob])).toContainEqual([
      'src/app/legacy.ts',
      'exempt-file',
      'src/app/legacy.ts',
    ]);
    expect(r.suppressedCounts.exemptFile).toBe(1);
  });

  test('excludeTests suppresses x.spec.ts and __tests__/ files', () => {
    const r = run([{ ...base, excludeTests: true }]);
    const suppressedFiles = r.suppressed.map((s) => s.violation.file).sort();
    expect(suppressedFiles).toEqual(['src/app/__tests__/helper.ts', 'src/app/page.spec.ts']);
    expect(reported(r)).not.toContain('src/app/page.spec.ts→@scope/forbidden');
  });

  test("a '!**/*.spec.ts' entry in from behaves exactly like exemptFiles ['**/*.spec.ts']", () => {
    const viaBang = run([{ ...base, from: ['src/app/**', '!**/*.spec.ts'] }]);
    const viaField = run([{ ...base, exemptFiles: ['**/*.spec.ts'] }]);
    expect(reported(viaBang)).toEqual(reported(viaField));
    expect(viaBang.suppressed.map((s) => s.violation.file)).toEqual(['src/app/page.spec.ts']);
    // The `!` glob is an exemption, never a dead literal scope glob.
    expect(viaBang.coverage[0]!.fromGlobs.map((g) => g.glob)).toEqual(['src/app/**']);
  });

  test('an exemption the author wrote that exempts nothing is a dead unit', () => {
    const r = run([{ ...base, exemptFiles: ['src/app/nope/**'] }]);
    expect(r.deadUnits.map((d) => [d.unit, d.selector])).toEqual([['exemptFiles', 'src/app/nope/**']]);
  });
});

describe('exceptions allow exactly one adjudicated edge, and rot loudly', () => {
  test('an exception suppresses exactly its (path, target) edge and nothing else', () => {
    const r = run([
      {
        ...base,
        exceptions: [{ path: 'src/app/page.ts', target: '@scope/forbidden', reason: 'ADR-12: page owns the bridge' }],
      },
    ]);
    expect(r.suppressed.filter((s) => s.reason === 'exception').map((s) => `${s.violation.file}→${s.violation.importSpecifier}`)).toEqual([
      'src/app/page.ts→@scope/forbidden',
    ]);
    // Same file, other target: still reported. Other files, same target: still reported.
    expect(reported(r)).toContain('src/app/page.ts→@scope/other');
    expect(reported(r)).toContain('src/app/legacy.ts→@scope/forbidden');
    expect(r.staleExceptions).toEqual([]);
  });

  test('an exception that matches no violating edge is a stale-exception ERROR', () => {
    const r = run([
      { ...base, exceptions: [{ path: 'src/app/gone.ts', target: '@scope/forbidden', reason: 'was sanctioned once' }] },
    ]);
    expect(r.staleExceptions.map((s) => [s.ruleId, s.index, s.severity])).toEqual([['app.no-forbidden', 0, 'error']]);
    expect(r.staleExceptions[0]!.message).toContain('src/app/gone.ts');
    expect(r.staleExceptions[0]!.message).toContain('was sanctioned once');
  });

  test('overlapping exceptions: every matching one is credited, the edge is suppressed once, neither is stale', () => {
    // Review repro: an area-wide exception next to a file-level one for the
    // same edge. Crediting only the FIRST match reported the second as a
    // stale-exception ERROR (exit 1) while it matched a real edge.
    const r = run([
      {
        ...base,
        forbiddenImports: ['@scope/forbidden'],
        exceptions: [
          { path: 'src/app/**', target: '@scope/forbidden', reason: 'area-wide migration' },
          { path: 'src/app/legacy.ts', target: '@scope/forbidden', reason: 'legacy file' },
        ],
      },
    ]);
    expect(r.staleExceptions).toEqual([]);
    expect(r.violations).toEqual([]);
    // Suppressed exactly once per edge, attributed to the first match.
    const legacy = r.suppressed.filter((s) => s.violation.file === 'src/app/legacy.ts');
    expect(legacy.map((s) => [s.reason, s.exception?.reason])).toEqual([['exception', 'area-wide migration']]);
    expect(r.suppressedCounts.exception).toBe(4);
    // Both exceptions are credited with what they match.
    expect(r.coverage[0]!.exceptions.map((e) => [e.reason, e.matched])).toEqual([
      ['area-wide migration', 4],
      ['legacy file', 1],
    ]);
  });

  test('an exception without a reason fails validation, and the loader lists it as an invalid rule', async () => {
    const v = validateBoundaryRule({ ...base, exceptions: [{ path: 'a.ts', target: 'b', reason: '' }] });
    expect(v.valid).toBe(false);
    expect(v.issues.map((i) => i.field)).toEqual(['exceptions[0].reason']);
    const root = workspace({
      'sharkcraft/boundaries.ts': `export default [
  { id: 'no-reason', title: 'No reason', from: ['src/**'], forbiddenImports: ['x'], exceptions: [{ path: 'a.ts', target: 'x', reason: '' }] },
];
`,
    });
    const loaded = await loadBoundaryRulesFromFile(join(root, 'sharkcraft', 'boundaries.ts'));
    expect(loaded.rules).toEqual([]);
    expect(loaded.invalid.map((i) => i.ruleId)).toEqual(['no-reason']);
  });
});

describe('one scope authority — every reader agrees with the evaluator', () => {
  test('boundaryRuleCovers ≡ the evaluator scope decision, for every scanned file (rules from a real boundaries.ts)', async () => {
    const root = workspace({
      ...FILES,
      'src/lib/other.ts': "import { F } from '@scope/forbidden';\n",
      'sharkcraft/boundaries.ts': `export default [
  { id: 'r1', title: 'R1', from: ['src/app/**', '!**/*.spec.ts'], forbiddenImports: ['@scope/forbidden'] },
  { id: 'r2', title: 'R2', from: ['src/**'], excludeTests: true, exemptFiles: ['src/lib/**'], forbiddenImports: ['@scope/forbidden'] },
];
`,
    });
    const loaded = await loadBoundaryRulesFromFile(join(root, 'sharkcraft', 'boundaries.ts'));
    const scan = scanImports({ projectRoot: root });
    const r = evaluateBoundaries(scan, loaded.rules);
    for (const rule of loaded.rules) {
      const cov = r.coverage.find((c) => c.ruleId === rule.id)!;
      const decisions = (scan.files ?? []).map((f) => boundaryRuleCovers(rule, f));
      expect({ rule: rule.id, in: cov.filesInScope, exempt: cov.exemptFilesInScope }).toEqual({
        rule: rule.id,
        in: decisions.filter((d) => d === 'in').length,
        exempt: decisions.filter((d) => d === 'exempt').length,
      });
      // Every reported violation sits in a file the authority calls governed.
      for (const v of r.violations.filter((x) => x.ruleId === rule.id)) {
        expect(boundaryRuleCovers(rule, v.file)).toBe('in');
      }
      for (const s of r.suppressed.filter((x) => x.violation.ruleId === rule.id && x.reason === 'exempt-file')) {
        expect(boundaryRuleCovers(rule, s.violation.file)).toBe('exempt');
      }
    }
  });
});
