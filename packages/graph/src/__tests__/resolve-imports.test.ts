import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createImportResolverContext,
  ImportResolution,
  resolveImport,
} from '../indexer/resolve-imports.ts';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'resolve-imports-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  // A TypeScript module that NodeNext callers import as `./target.js`.
  writeFileSync(join(root, 'src', 'target.ts'), 'export const x = 1;\n');
  // A directory module imported as `./dir/index.js`.
  mkdirSync(join(root, 'src', 'dir'), { recursive: true });
  writeFileSync(join(root, 'src', 'dir', 'index.ts'), 'export const y = 2;\n');
  // A genuine hand-written `.js` file (no `.ts` sibling) must still win.
  writeFileSync(join(root, 'src', 'legacy.js'), 'module.exports = {};\n');
  // One on-disk source per remaining JS_TO_TS_EXTS row, so every mapping is
  // pinned (a typo like `.mjs`->`.ts` would then fail CI).
  writeFileSync(join(root, 'src', 'esm.mts'), 'export const m = 1;\n'); // .mjs -> .mts
  writeFileSync(join(root, 'src', 'cjs-mod.cts'), 'export const c = 1;\n'); // .cjs -> .cts
  writeFileSync(join(root, 'src', 'comp.tsx'), 'export const C = 1;\n'); // .jsx -> .tsx
  writeFileSync(join(root, 'src', 'view.tsx'), 'export const V = 1;\n'); // .js -> .tsx fallback (no .ts sibling)
  // A declaration-only module (no impl sibling) — still a resolvable target.
  writeFileSync(join(root, 'src', 'types.d.ts'), 'export interface T { a: number }\n');
  // An impl + its declaration: the implementation must win.
  writeFileSync(join(root, 'src', 'dual.ts'), 'export const d = 1;\n');
  writeFileSync(join(root, 'src', 'dual.d.ts'), 'export declare const d: number;\n');
  // The importing file.
  writeFileSync(join(root, 'src', 'a.ts'), '');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveImport — NodeNext .js → .ts', () => {
  test('a `.js`-suffixed relative import resolves to the `.ts` source on disk', () => {
    const ctx = createImportResolverContext(root, []);
    const r = resolveImport('./target.js', join(root, 'src', 'a.ts'), ctx);
    expect(r.kind).toBe(ImportResolution.Relative);
    expect(r.targetPath).toBe('src/target.ts');
  });

  test('a `./dir/index.js` import resolves to the directory `index.ts`', () => {
    const ctx = createImportResolverContext(root, []);
    const r = resolveImport('./dir/index.js', join(root, 'src', 'a.ts'), ctx);
    expect(r.kind).toBe(ImportResolution.Relative);
    expect(r.targetPath).toBe('src/dir/index.ts');
  });

  test('a real `.js` file with no `.ts` sibling still resolves to itself', () => {
    const ctx = createImportResolverContext(root, []);
    const r = resolveImport('./legacy.js', join(root, 'src', 'a.ts'), ctx);
    expect(r.kind).toBe(ImportResolution.Relative);
    expect(r.targetPath).toBe('src/legacy.js');
  });

  test('an extensionless relative import still resolves (regression guard)', () => {
    const ctx = createImportResolverContext(root, []);
    const r = resolveImport('./target', join(root, 'src', 'a.ts'), ctx);
    expect(r.kind).toBe(ImportResolution.Relative);
    expect(r.targetPath).toBe('src/target.ts');
  });

  test('a `.js` import with neither `.js` nor `.ts` on disk stays unresolved', () => {
    const ctx = createImportResolverContext(root, []);
    const r = resolveImport('./does-not-exist.js', join(root, 'src', 'a.ts'), ctx);
    expect(r.kind).toBe(ImportResolution.Unresolved);
  });

  test('pins every JS_TO_TS_EXTS mapping (.mjs->.mts, .cjs->.cts, .jsx->.tsx, .js->.tsx)', () => {
    const ctx = createImportResolverContext(root, []);
    const from = join(root, 'src', 'a.ts');
    const cases: Array<[string, string]> = [
      ['./esm.mjs', 'src/esm.mts'],
      ['./cjs-mod.cjs', 'src/cjs-mod.cts'],
      ['./comp.jsx', 'src/comp.tsx'],
      ['./view.js', 'src/view.tsx'], // .js falls through .ts (absent) to .tsx
    ];
    for (const [spec, expected] of cases) {
      const r = resolveImport(spec, from, ctx);
      expect(r.kind).toBe(ImportResolution.Relative);
      expect(r.targetPath).toBe(expected);
    }
  });
});

describe('resolveImport — declaration-only modules', () => {
  test('a `.js` import whose only sibling is a `.d.ts` resolves to it', () => {
    const ctx = createImportResolverContext(root, []);
    const r = resolveImport('./types.js', join(root, 'src', 'a.ts'), ctx);
    expect(r.kind).toBe(ImportResolution.Relative);
    expect(r.targetPath).toBe('src/types.d.ts');
  });

  test('an extensionless import of a declaration-only module resolves to it', () => {
    const ctx = createImportResolverContext(root, []);
    const r = resolveImport('./types', join(root, 'src', 'a.ts'), ctx);
    expect(r.kind).toBe(ImportResolution.Relative);
    expect(r.targetPath).toBe('src/types.d.ts');
  });

  test('an implementation file wins over its `.d.ts` declaration', () => {
    const ctx = createImportResolverContext(root, []);
    expect(resolveImport('./dual.js', join(root, 'src', 'a.ts'), ctx).targetPath).toBe('src/dual.ts');
    expect(resolveImport('./dual', join(root, 'src', 'a.ts'), ctx).targetPath).toBe('src/dual.ts');
  });
});
