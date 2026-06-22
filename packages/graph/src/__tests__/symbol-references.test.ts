import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '../indexer/index-builder.ts';
import { extractTsFile } from '../indexer/extract-ts-file.ts';
import { fingerprintFile } from '../store/file-fingerprint.ts';
import { GraphQueryApi } from '../query/query-api.ts';
import { EdgeKind } from '../schema/edge-kind.ts';

describe('extract — bindings + identifier refs', () => {
  test('captures named/default imports and call/non-call references', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-graph-refs-extract-'));
    try {
      const file = join(root, 'sample.ts');
      writeFileSync(
        file,
        [
          "import alpha, { other as O } from './m';",
          "import type { OnlyType } from './t';",
          "const x = alpha();",
          "const y = O;",
          "type T = OnlyType;",
        ].join('\n'),
      );
      const fp = fingerprintFile(file, root);
      const ex = extractTsFile(fp, file);
      const bindings = ex.importBindings
        .filter((b) => !b.isTypeOnly)
        .map((b) => `${b.localName}=${b.specifier}#${b.importedName}(${b.isDefault ? 'default' : 'named'})`)
        .sort();
      expect(bindings).toContain('O=./m#other(named)');
      expect(bindings).toContain('alpha=./m#default(default)');
      // Type-only imports are CAPTURED but tagged `isTypeOnly` (heritage uses
      // them; value-reference resolution ignores them) — so OnlyType is present
      // in the list yet excluded from the value bindings above.
      const onlyType = ex.importBindings.find((b) => b.localName === 'OnlyType');
      expect(onlyType?.isTypeOnly).toBe(true);
      const refs = ex.identifierReferences.map((r) => `${r.name}:${r.line}:${r.isCall ? 'call' : 'ref'}`);
      expect(refs.some((r) => r.startsWith('alpha:3:call'))).toBe(true);
      expect(refs.some((r) => r.startsWith('O:4:ref'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('graph — references-symbol / calls-symbol edges end-to-end', () => {
  function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'shrk-graph-refs-e2e-'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
    );
    mkdirSync(join(root, 'packages', 'alpha', 'src'), { recursive: true });
    mkdirSync(join(root, 'packages', 'beta', 'src'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'alpha', 'package.json'),
      JSON.stringify({ name: '@demo/alpha', main: 'src/index.ts' }, null, 2),
    );
    writeFileSync(
      join(root, 'packages', 'beta', 'package.json'),
      JSON.stringify({ name: '@demo/beta', main: 'src/index.ts' }, null, 2),
    );
    writeFileSync(
      join(root, 'packages', 'alpha', 'src', 'index.ts'),
      [
        "export function alpha() { return 1; }",
        "export const ALPHA_TAG = 'alpha';",
      ].join('\n'),
    );
    writeFileSync(
      join(root, 'packages', 'beta', 'src', 'index.ts'),
      [
        "import { alpha, ALPHA_TAG } from '@demo/alpha';",
        "export function useAlpha() { return alpha() + ALPHA_TAG; }",
        "export const callsAlphaTwice = () => alpha();",
      ].join('\n'),
    );
    return root;
  }

  test('beta gets calls-symbol edge to alpha.alpha and references edge to ALPHA_TAG', () => {
    const root = fixture();
    try {
      buildFullIndex({ projectRoot: root });
      const q = GraphQueryApi.fromStore(root);
      const alphaFile = q.findFile('packages/alpha/src/index.ts')!;
      const alphaFn = q.symbolsIn(alphaFile.id).find((s) => s.label === 'alpha')!;
      const alphaTag = q.symbolsIn(alphaFile.id).find((s) => s.label === 'ALPHA_TAG')!;

      const callers = q.callersOf(alphaFn.id);
      expect(callers.some((c) => c.path === 'packages/beta/src/index.ts')).toBe(true);

      const taggers = q.referencesOf(alphaTag.id);
      expect(taggers.some((c) => c.path === 'packages/beta/src/index.ts')).toBe(true);

      // Verify the edges actually exist with the right kinds.
      const neighbours = q.neighbours(alphaFn.id)!;
      const callEdges = neighbours.in.filter((e) => e.edge.kind === EdgeKind.CallsSymbol);
      expect(callEdges.length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('callerSitesOf / referenceSitesOf carry the call-site line (path:line truth)', () => {
    const root = fixture();
    try {
      buildFullIndex({ projectRoot: root });
      const q = GraphQueryApi.fromStore(root);
      const alphaFile = q.findFile('packages/alpha/src/index.ts')!;
      const alphaFn = q.symbolsIn(alphaFile.id).find((s) => s.label === 'alpha')!;

      const sites = q.callerSitesOf(alphaFn.id);
      const betaSite = sites.find((s) => s.node.path === 'packages/beta/src/index.ts');
      expect(betaSite).toBeDefined();
      // beta/src/index.ts calls alpha() — the line must be a real 1-based
      // source line carried from the edge, not undefined (the gap that made
      // `graph callers` strictly worse than grep before this).
      expect(typeof betaSite!.line).toBe('number');
      expect(betaSite!.line).toBeGreaterThan(0);

      // referenceSitesOf carries the line for non-call references too.
      const alphaTag = q.symbolsIn(alphaFile.id).find((s) => s.label === 'ALPHA_TAG')!;
      const refSites = q.referenceSitesOf(alphaTag.id);
      const tagSite = refSites.find((s) => s.node.path === 'packages/beta/src/index.ts');
      expect(tagSite).toBeDefined();
      expect(typeof tagSite!.line).toBe('number');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('local same-file references emit edges too', () => {
    const root = fixture();
    try {
      // Add a same-file call.
      writeFileSync(
        join(root, 'packages', 'alpha', 'src', 'index.ts'),
        [
          "export function alpha() { return 1; }",
          "export const ALPHA_TAG = 'alpha';",
          "function inner() { return alpha(); }",
          "export const reuse = inner();",
        ].join('\n'),
      );
      buildFullIndex({ projectRoot: root });
      const q = GraphQueryApi.fromStore(root);
      const alphaFile = q.findFile('packages/alpha/src/index.ts')!;
      const alphaFn = q.symbolsIn(alphaFile.id).find((s) => s.label === 'alpha')!;
      const callers = q.callersOf(alphaFn.id);
      // alpha is called by alpha.ts itself (via inner) AND by beta. The
      // self-loop is filtered by stitchPerFileReferences, but the
      // file-level same-file edge is still emitted (alpha.ts → symbol:alpha.ts#alpha).
      expect(callers.some((c) => c.path === 'packages/alpha/src/index.ts')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('graph — barrel re-export resolution (cross-package callers)', () => {
  function barrelFixture(reExportLine: string): string {
    const root = mkdtempSync(join(tmpdir(), 'shrk-graph-barrel-'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
    );
    mkdirSync(join(root, 'packages', 'core', 'src'), { recursive: true });
    mkdirSync(join(root, 'packages', 'app', 'src'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'core', 'package.json'),
      JSON.stringify({ name: '@demo/core', main: 'src/index.ts' }, null, 2),
    );
    writeFileSync(
      join(root, 'packages', 'app', 'package.json'),
      JSON.stringify({ name: '@demo/app', main: 'src/index.ts' }, null, 2),
    );
    // coreThing is DECLARED in a sub-file and only re-exported via the barrel.
    writeFileSync(
      join(root, 'packages', 'core', 'src', 'thing.ts'),
      'export function coreThing() { return 1; }\n',
    );
    writeFileSync(join(root, 'packages', 'core', 'src', 'index.ts'), reExportLine + '\n');
    // app consumes it via the PACKAGE BARREL — the cross-package case that
    // used to bind to a phantom symbol:<barrel>#coreThing and vanish.
    writeFileSync(
      join(root, 'packages', 'app', 'src', 'index.ts'),
      [
        "import { coreThing } from '@demo/core';",
        'export function useIt() { return coreThing(); }',
      ].join('\n'),
    );
    return root;
  }

  function assertConsumerVisible(reExportLine: string): void {
    const root = barrelFixture(reExportLine);
    try {
      buildFullIndex({ projectRoot: root });
      const q = GraphQueryApi.fromStore(root);
      const coreFile = q.findFile('packages/core/src/thing.ts')!;
      const coreThing = q.symbolsIn(coreFile.id).find((s) => s.label === 'coreThing')!;
      const callers = q.callersOf(coreThing.id);
      // Without re-export resolution this is empty (the call edge pointed at
      // the phantom barrel symbol); with it, the cross-package consumer
      // resolves onto the real declaration.
      expect(callers.some((c) => c.path === 'packages/app/src/index.ts')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test('star re-export (`export * from`) surfaces the cross-package caller', () => {
    assertConsumerVisible("export * from './thing.ts';");
  });

  test('named re-export (`export { X } from`) surfaces the cross-package caller', () => {
    assertConsumerVisible("export { coreThing } from './thing.ts';");
  });
});
