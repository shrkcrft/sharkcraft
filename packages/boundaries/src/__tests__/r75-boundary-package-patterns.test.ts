/**
 * Round 11 (1.5) — a bare forbidden package pattern covers the package's
 * subpaths.
 *
 * The glob's `*` never crosses `/` (glob.test.ts pins it), so a rule naming
 * `@scope/package-a` or `@scope/package-*` used to match ONLY the entrypoint:
 * every `@scope/package-a/sub` import of the same forbidden package escaped the
 * fence while the gate reported green. Package semantics live in the boundary
 * evaluator's matcher (not glob.ts), with an explicit exact-entrypoint opt-out.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  evaluateBoundaries,
  globToRegex,
  isPackagePattern,
  loadBoundaryRulesFromFile,
  loadTsconfigPaths,
  matchImportPattern,
  scanImports,
  type IBoundaryRule,
} from '../index.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-pkg-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const X_TS = [
  "import { a } from '@scope/package-a';",
  "import { sub } from '@scope/package-a/sub';",
  "import { deep } from '@scope/package-b/deep/thing';",
  "import { legacy } from '@scope/package-a-legacy';",
].join('\n');

function run(rules: readonly IBoundaryRule[], root: string) {
  const tsconfigPaths = loadTsconfigPaths(root);
  return evaluateBoundaries(scanImports({ projectRoot: root }), rules, {
    ...(tsconfigPaths.aliases.size > 0 ? { tsconfigPaths } : {}),
  });
}

const rule = (over: Partial<IBoundaryRule>): IBoundaryRule => ({
  id: 'app.fence',
  title: 'App fence',
  severity: 'error',
  from: ['packages/app/**'],
  ...over,
});

describe('package semantics for forbiddenImports', () => {
  const root = workspace({ 'packages/app/x.ts': X_TS });

  test('a bare pattern reports BOTH the entrypoint and a subpath import; the subpath one says so', () => {
    const r = run([rule({ forbiddenImports: ['@scope/package-a'] })], root);
    expect(r.violations.map((v) => [v.importSpecifier, v.line, v.matchKind])).toEqual([
      ['@scope/package-a', 1, 'exact'],
      ['@scope/package-a/sub', 2, 'subpath'],
    ]);
  });

  test("'@scope/package-*' reaches '@scope/package-b/deep/thing'; '@scope/package-a' never reaches '@scope/package-a-legacy'", () => {
    const star = run([rule({ forbiddenImports: ['@scope/package-*'] })], root);
    expect(star.violations.map((v) => v.importSpecifier)).toContain('@scope/package-b/deep/thing');
    const bare = run([rule({ forbiddenImports: ['@scope/package-a'] })], root);
    expect(bare.violations.map((v) => v.importSpecifier)).not.toContain('@scope/package-a-legacy');
  });

  test("forbiddenMatch: 'exact' restores entrypoint-only matching (the barrel-avoidance opt-out)", () => {
    const r = run([rule({ forbiddenImports: ['@scope/package-a'], forbiddenMatch: 'exact' })], root);
    expect(r.violations.map((v) => v.importSpecifier)).toEqual(['@scope/package-a']);
  });

  test("a pattern containing '**' behaves exactly as before", () => {
    const r = run([rule({ forbiddenImports: ['@scope/package-a/**'] })], root);
    // `**` already says how deep: the entrypoint itself is not `@scope/package-a/<x>`.
    expect(r.violations.map((v) => v.importSpecifier)).toEqual(['@scope/package-a/sub']);
    expect(isPackagePattern('@scope/package-a/**')).toBe(false);
    expect(matchImportPattern('@scope/package-a', 'packages/**/internal')).toBeNull();
    expect(matchImportPattern('packages/x/internal', 'packages/**/internal')).toBe('exact');
  });

  test('allowedImports is never widened: allowing react-dom still flags react-dom/client', () => {
    const r2 = workspace({ 'packages/app/y.ts': "import { c } from 'react-dom/client';\nimport d from 'react-dom';\n" });
    const r = run([rule({ allowedImports: ['react-dom'] })], r2);
    expect(r.violations.map((v) => [v.importSpecifier, v.notAllowed])).toEqual([['react-dom/client', true]]);
  });

  test('a bare directory pattern matches an alias-resolved candidate path', () => {
    const r3 = workspace({
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@app/ui': ['packages/ui/src/index.ts'] } } }),
      'packages/core/a.ts': "import { Button } from '@app/ui';\n",
      'packages/ui/src/index.ts': 'export const Button = 1;\n',
    });
    const r = run([rule({ id: 'core.no-ui', from: ['packages/core/**'], forbiddenImports: ['packages/ui'] })], r3);
    expect(r.violations.map((v) => [v.importSpecifier, v.resolvedVia, v.matchKind])).toEqual([
      ['@app/ui', 'packages/ui/src/index.ts', 'subpath'],
    ]);
  });

  test('the generic glob keeps `*` from crossing `/` (package semantics are the evaluator\'s, not glob.ts\'s)', () => {
    expect(globToRegex('@demo/ui-*').test('@demo/ui-angular/internal')).toBe(false);
    expect(matchImportPattern('@demo/ui-angular/internal', '@demo/ui-*')).toBe('subpath');
  });
});

describe('rules loaded through the real boundaryFiles loader', () => {
  test('a bare pattern in a real sharkcraft/boundaries.ts catches the subpath import', async () => {
    const root = workspace({
      'packages/app/x.ts': X_TS,
      'sharkcraft/boundaries.ts': `export default [
  { id: 'app.no-package-a', title: 'No package-a', severity: 'error', from: ['packages/app/**'], forbiddenImports: ['@scope/package-a'] },
];
`,
    });
    const loaded = await loadBoundaryRulesFromFile(join(root, 'sharkcraft', 'boundaries.ts'));
    expect(loaded.invalid).toEqual([]);
    const r = run(loaded.rules, root);
    expect(r.violations.filter((v) => v.matchKind === 'subpath').map((v) => v.importSpecifier)).toEqual([
      '@scope/package-a/sub',
    ]);
  });

  test("an unknown forbiddenMatch value fails validation — never a silent default", async () => {
    const root = workspace({
      'sharkcraft/boundaries.ts': `export default [
  { id: 'bad', title: 'Bad', from: ['src/**'], forbiddenImports: ['x'], forbiddenMatch: 'loose' },
];
`,
    });
    const loaded = await loadBoundaryRulesFromFile(join(root, 'sharkcraft', 'boundaries.ts'));
    expect(loaded.rules).toEqual([]);
    expect(loaded.invalid[0]?.issues.map((i) => i.field)).toEqual(['forbiddenMatch']);
  });
});
