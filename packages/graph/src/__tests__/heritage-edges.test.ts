import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '../indexer/index-builder.ts';
import { GraphQueryApi } from '../query/query-api.ts';
import { EdgeKind } from '../schema/edge-kind.ts';

function fixture(src: string): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-heritage-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }));
  mkdirSync(join(root, 'packages', 'p', 'src'), { recursive: true });
  writeFileSync(join(root, 'packages', 'p', 'package.json'), JSON.stringify({ name: '@demo/p', main: 'src/index.ts' }));
  writeFileSync(join(root, 'packages', 'p', 'src', 'index.ts'), src);
  return root;
}

const SRC = [
  'export interface Animal { name: string; }',
  'export class Base { greet() { return 1; } }',
  'export class Dog extends Base implements Animal { name = "d"; }',
  'export class Cat extends Base implements Animal { name = "c"; }',
  '',
].join('\n');

describe('extends / implements graph edges', () => {
  test('the extractor emits typed extends-symbol and implements-symbol edges', () => {
    const root = fixture(SRC);
    try {
      buildFullIndex({ projectRoot: root });
      const api = GraphQueryApi.fromStore(root);
      const dog = api.neighbours('symbol:packages/p/src/index.ts#Dog')!;
      const kinds = dog.out.map((o) => o.edge.kind);
      expect(kinds).toContain(EdgeKind.ExtendsSymbol);
      expect(kinds).toContain(EdgeKind.ImplementsSymbol);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('subtypesOf returns every implementer / subclass of a type', () => {
    const root = fixture(SRC);
    try {
      buildFullIndex({ projectRoot: root });
      const api = GraphQueryApi.fromStore(root);
      const animalSubtypes = api.subtypesOf('symbol:packages/p/src/index.ts#Animal').map((n) => n.label).sort();
      expect(animalSubtypes).toEqual(['Cat', 'Dog']);
      const baseSubtypes = api.subtypesOf('symbol:packages/p/src/index.ts#Base').map((n) => n.label).sort();
      expect(baseSubtypes).toEqual(['Cat', 'Dog']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('supertypesOf returns the bases a class extends / implements', () => {
    const root = fixture(SRC);
    try {
      buildFullIndex({ projectRoot: root });
      const api = GraphQueryApi.fromStore(root);
      const supers = api.supertypesOf('symbol:packages/p/src/index.ts#Dog').map((n) => n.label).sort();
      expect(supers).toEqual(['Animal', 'Base']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('resolves heritage across files through a `import type` interface', () => {
    // The realistic shape: an interface in its own file, imported `import type`
    // by an implementer in another file. The type-only import must still
    // connect the implementer to the interface.
    const root = mkdtempSync(join(tmpdir(), 'shrk-heritage-x-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }));
      mkdirSync(join(root, 'packages', 'p', 'src'), { recursive: true });
      writeFileSync(join(root, 'packages', 'p', 'package.json'), JSON.stringify({ name: '@demo/p', main: 'src/index.ts' }));
      writeFileSync(join(root, 'packages', 'p', 'src', 'store.ts'), 'export interface IStore { get(): number; }\n');
      writeFileSync(
        join(root, 'packages', 'p', 'src', 'mem-store.ts'),
        "import type { IStore } from './store.ts';\nexport class MemStore implements IStore { get() { return 1; } }\n",
      );
      buildFullIndex({ projectRoot: root });
      const api = GraphQueryApi.fromStore(root);
      const impls = api.subtypesOf('symbol:packages/p/src/store.ts#IStore').map((n) => n.label);
      expect(impls).toEqual(['MemStore']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an interface implemented across files ranks as a topHubs symbol', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-heritage-hub-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }));
      mkdirSync(join(root, 'packages', 'p', 'src'), { recursive: true });
      writeFileSync(join(root, 'packages', 'p', 'package.json'), JSON.stringify({ name: '@demo/p', main: 'src/index.ts' }));
      writeFileSync(join(root, 'packages', 'p', 'src', 'store.ts'), 'export interface IStore { get(): number; }\n');
      for (const cls of ['A', 'B'] as const) {
        writeFileSync(
          join(root, 'packages', 'p', 'src', `${cls.toLowerCase()}.ts`),
          `import type { IStore } from './store.ts';\nexport class ${cls} implements IStore { get() { return 1; } }\n`,
        );
      }
      buildFullIndex({ projectRoot: root });
      const api = GraphQueryApi.fromStore(root);
      // IStore is implemented by two classes in two distinct files (and has no
      // reference edge — both imports are `import type`), so its hub in-degree
      // is the two implementer files.
      const hub = api.topHubs().symbols.find((h) => h.node.label === 'IStore');
      expect(hub?.inDegree).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('pathBetween traverses an implements edge (file → interface via its class)', () => {
    const root = fixture(SRC);
    try {
      buildFullIndex({ projectRoot: root });
      const api = GraphQueryApi.fromStore(root);
      const path = api.pathBetween('file:packages/p/src/index.ts', 'symbol:packages/p/src/index.ts#Animal');
      expect(path.found).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
