/**
 * Round 74 — module-level importer queries.
 *
 * Relocating or deleting a module needs the set of every module that imports
 * it. `callersOf` cannot answer that: it is symbol-scoped and counts call
 * sites, so it is blind to exactly the two edges that decide whether the move
 * is safe — a type-only import (no call site exists) and a re-export (the
 * module stays publicly surfaced under another path). The lock is that
 * `importerEdgesOf` finds all of them, tagged, and that `callersOf` finds
 * strictly fewer.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '../indexer/index-builder.ts';
import { GraphQueryApi } from '../query/query-api.ts';

function write(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
}

/**
 * A target module reached four different ways, each of which a hand-rolled grep
 * or a symbol-level query gets wrong on its own.
 */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-graph-importers-'));
  write(root, 'package.json', JSON.stringify({ name: 'fx', version: '0.0.0' }));
  write(
    root,
    'tsconfig.json',
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['libs/*'] } } }),
  );
  write(root, 'libs/target.ts', 'export const doThing = (): number => 1;\nexport interface IThing { n: number }\n');
  // 1. a plain value import that CALLS the symbol.
  write(root, 'src/caller.ts', "import { doThing } from '../libs/target';\nexport const x = doThing();\n");
  // 2. through a tsconfig path alias — the specifier a grep for '../libs' misses.
  write(root, 'src/aliased.ts', "import { doThing } from '@lib/target';\nexport const y = doThing();\n");
  // 3. a `.js`-suffixed ESM specifier resolving to the `.ts` source.
  write(root, 'src/esm.ts', "import { doThing } from '../libs/target.js';\nexport const z = doThing();\n");
  // 4. type-only: no call site at all, so `callers` cannot see it.
  write(root, 'src/typed.ts', "import type { IThing } from '../libs/target';\nexport const t: IThing = { n: 1 };\n");
  // 5. a barrel that re-exports it onward — the module stays publicly surfaced.
  write(root, 'src/barrel.ts', "export * from '../libs/target';\n");
  return root;
}

describe('importerEdgesOf', () => {
  test('finds every importer across alias, .js-suffix, type-only and re-export edges', () => {
    const root = fixture();
    try {
      buildFullIndex({ projectRoot: root });
      const api = GraphQueryApi.fromStore(root);
      const target = api.findFile('libs/target.ts');
      expect(target).toBeDefined();

      const edges = api.importerEdgesOf(target!.id);
      const paths = edges.map((e) => e.node.path).sort();
      expect(paths).toEqual([
        'src/aliased.ts',
        'src/barrel.ts',
        'src/caller.ts',
        'src/esm.ts',
        'src/typed.ts',
      ]);

      const kindOf = (p: string): string => {
        const e = edges.find((x) => x.node.path === p)!;
        return e.typeOnly ? 'type-only' : e.kind;
      };
      expect(kindOf('src/caller.ts')).toBe('import');
      expect(kindOf('src/aliased.ts')).toBe('import');
      expect(kindOf('src/esm.ts')).toBe('import');
      expect(kindOf('src/typed.ts')).toBe('type-only');
      // `export * from` is the most common way a module stays reachable, and
      // the case a symbol-keyed re-export lookup silently misses.
      expect(kindOf('src/barrel.ts')).toBe('reexport');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a symbol-level callers query returns strictly fewer — the gap this closes', () => {
    const root = fixture();
    try {
      buildFullIndex({ projectRoot: root });
      const api = GraphQueryApi.fromStore(root);
      const target = api.findFile('libs/target.ts')!;
      const importers = api.importerEdgesOf(target.id);

      const sym = api.findSymbol('doThing', { exact: true, limit: 1 })[0];
      expect(sym).toBeDefined();
      const callers = api.callersOf(sym!.id);
      expect(callers.length).toBeLessThan(importers.length);
      // Specifically: the type-only importer and the barrel are invisible to it.
      const callerPaths = new Set(callers.map((c) => c.path));
      expect(callerPaths.has('src/typed.ts')).toBe(false);
      expect(callerPaths.has('src/barrel.ts')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a bare specifier resolves to the same node as its repo-relative path', () => {
    const root = fixture();
    try {
      buildFullIndex({ projectRoot: root });
      const api = GraphQueryApi.fromStore(root);
      // The alias is what the INDEXER resolved, so both spellings land on one
      // node — no second resolver to disagree with the graph.
      expect(api.fileForSpecifier('@lib/target')?.path).toBe('libs/target.ts');
      expect(api.findFile('libs/target.ts')?.id).toBe(api.fileForSpecifier('@lib/target')?.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
