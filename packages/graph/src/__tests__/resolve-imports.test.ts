import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createImportResolverContext,
  ImportResolution,
  resolveImport,
} from '../indexer/resolve-imports.ts';
import { buildFullIndex } from '../indexer/index-builder.ts';
import { GraphQueryApi } from '../query/query-api.ts';
import { EdgeKind } from '../schema/edge-kind.ts';

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

describe('resolveReExportedReferenceEdges — RENAMED barrel re-exports', () => {
  // A 2-package workspace where `core` declares a symbol in a sub-file and
  // re-exports it through its barrel under a DIFFERENT exposed name; `app`
  // consumes it via the package barrel (the cross-package case that used to
  // bind to a phantom `symbol:<barrel>#<exposed>` and vanish from callers).
  function renameFixture(opts: {
    subFile: string;
    subContent: string;
    barrelLine: string;
    importedName: string;
  }): string {
    const r = mkdtempSync(join(tmpdir(), 'shrk-graph-reexport-rename-'));
    writeFileSync(
      join(r, 'package.json'),
      JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
    );
    mkdirSync(join(r, 'packages', 'core', 'src'), { recursive: true });
    mkdirSync(join(r, 'packages', 'app', 'src'), { recursive: true });
    writeFileSync(
      join(r, 'packages', 'core', 'package.json'),
      JSON.stringify({ name: '@demo/core', main: 'src/index.ts' }, null, 2),
    );
    writeFileSync(
      join(r, 'packages', 'app', 'package.json'),
      JSON.stringify({ name: '@demo/app', main: 'src/index.ts' }, null, 2),
    );
    writeFileSync(join(r, 'packages', 'core', 'src', opts.subFile), opts.subContent + '\n');
    writeFileSync(join(r, 'packages', 'core', 'src', 'index.ts'), opts.barrelLine + '\n');
    writeFileSync(
      join(r, 'packages', 'app', 'src', 'index.ts'),
      [
        `import { ${opts.importedName} } from '@demo/core';`,
        `export function useIt() { return ${opts.importedName}(); }`,
      ].join('\n'),
    );
    return r;
  }

  function callEdgeFrom(q: GraphQueryApi, fileId: string) {
    return q.neighbours(fileId)!.out.find((o) => o.edge.kind === EdgeKind.CallsSymbol);
  }

  test('`export { FooImpl as Foo } from` resolves the consumer onto the real declaration', () => {
    const r = renameFixture({
      subFile: 'thing.ts',
      subContent: 'export function fooImpl() { return 1; }',
      barrelLine: "export { fooImpl as Foo } from './thing.ts';",
      importedName: 'Foo',
    });
    try {
      buildFullIndex({ projectRoot: r });
      const q = GraphQueryApi.fromStore(r);
      const subFile = q.findFile('packages/core/src/thing.ts')!;
      const real = q.symbolsIn(subFile.id).find((s) => s.label === 'fooImpl')!;
      expect(real.id).toBe('symbol:packages/core/src/thing.ts#fooImpl');

      // callersOf(real) sees the cross-barrel consumer…
      const callers = q.callersOf(real.id);
      expect(callers.some((c) => c.path === 'packages/app/src/index.ts')).toBe(true);

      // …because the rewritten calls-symbol edge now targets the REAL id, not
      // the `symbol:<barrel>#Foo` phantom the binder first produced.
      const appFile = q.findFile('packages/app/src/index.ts')!;
      expect(callEdgeFrom(q, appFile.id)!.edge.to).toBe(real.id);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  test('`export { default as Bar } from` resolves via the target default-export name', () => {
    const r = renameFixture({
      subFile: 'bar.ts',
      subContent: 'export default function barImpl() { return 2; }',
      barrelLine: "export { default as Bar } from './bar.ts';",
      importedName: 'Bar',
    });
    try {
      buildFullIndex({ projectRoot: r });
      const q = GraphQueryApi.fromStore(r);
      const subFile = q.findFile('packages/core/src/bar.ts')!;
      const real = q.symbolsIn(subFile.id).find((s) => s.label === 'barImpl')!;
      const callers = q.callersOf(real.id);
      expect(callers.some((c) => c.path === 'packages/app/src/index.ts')).toBe(true);
      const appFile = q.findFile('packages/app/src/index.ts')!;
      expect(callEdgeFrom(q, appFile.id)!.edge.to).toBe(real.id);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  test('a rename whose ORIGINAL name does not exist stays unresolved (no phantom edge)', () => {
    const r = renameFixture({
      subFile: 'thing.ts',
      // `Missing` is NOT declared here — only `realThing` is.
      subContent: 'export function realThing() { return 3; }',
      barrelLine: "export { Missing as Ghost } from './thing.ts';",
      importedName: 'Ghost',
    });
    try {
      buildFullIndex({ projectRoot: r });
      const q = GraphQueryApi.fromStore(r);
      const subFile = q.findFile('packages/core/src/thing.ts')!;
      const realThing = q.symbolsIn(subFile.id).find((s) => s.label === 'realThing')!;
      // The consumer must NOT be wired onto the unrelated real symbol.
      expect(q.callersOf(realThing.id).some((c) => c.path === 'packages/app/src/index.ts')).toBe(false);

      // The edge stays pointed at the unresolved barrel placeholder, and that
      // placeholder is a phantom — no symbol node exists for it (no invented edge).
      const appFile = q.findFile('packages/app/src/index.ts')!;
      const callEdge = callEdgeFrom(q, appFile.id)!;
      expect(callEdge.edge.to).toBe('symbol:packages/core/src/index.ts#Ghost');
      expect(q.neighbours(callEdge.edge.to)).toBeUndefined();
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });
});
