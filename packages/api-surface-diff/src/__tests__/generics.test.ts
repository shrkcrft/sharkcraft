import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffApiSurfaces, extractApiSurfaceWithProgram } from '../index.ts';

function fixture(body: string): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-gen-'));
  mkdirSync(join(root, 'packages', 'lib', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }),
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
      },
      include: ['packages/*/src/**/*.ts'],
    }),
  );
  writeFileSync(
    join(root, 'packages', 'lib', 'package.json'),
    JSON.stringify({ name: '@demo/lib', main: 'src/index.ts' }),
  );
  writeFileSync(join(root, 'packages', 'lib', 'src', 'index.ts'), body);
  return root;
}

describe('signature normalization: generic-parameter renames are not breaking', () => {
  test('function: renaming T → U is not a signature change', () => {
    const a = fixture('export function id<T>(x: T): T { return x; }');
    const b = fixture('export function id<U>(x: U): U { return x; }');
    try {
      const sa = extractApiSurfaceWithProgram({ projectRoot: a }).surface;
      const sb = extractApiSurfaceWithProgram({ projectRoot: b }).surface;
      const idA = sa.symbols.find((s) => s.name === 'id')!;
      const idB = sb.symbols.find((s) => s.name === 'id')!;
      expect(idA.signature).toBe(idB.signature);
      const diff = diffApiSurfaces(sa, sb);
      expect(diff.entries.filter((e) => e.kind === 'signature-changed').length).toBe(0);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  test('interface: renaming generic type-param is not a signature change', () => {
    const a = fixture('export interface IBox<T> { value: T; map<U>(fn: (v: T) => U): IBox<U>; }');
    const b = fixture('export interface IBox<X> { value: X; map<U>(fn: (v: X) => U): IBox<U>; }');
    try {
      const sa = extractApiSurfaceWithProgram({ projectRoot: a }).surface;
      const sb = extractApiSurfaceWithProgram({ projectRoot: b }).surface;
      expect(sa.symbols.find((s) => s.name === 'IBox')!.signature).toBe(
        sb.symbols.find((s) => s.name === 'IBox')!.signature,
      );
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  test('changing a constraint IS still a breaking change', () => {
    const a = fixture('export function id<T>(x: T): T { return x; }');
    const b = fixture('export function id<T extends string>(x: T): T { return x; }');
    try {
      const sa = extractApiSurfaceWithProgram({ projectRoot: a }).surface;
      const sb = extractApiSurfaceWithProgram({ projectRoot: b }).surface;
      const diff = diffApiSurfaces(sa, sb);
      const sig = diff.entries.find((e) => e.kind === 'signature-changed');
      expect(sig).toBeDefined();
      expect(sig!.severity).toBe('breaking');
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  test('adding a generic parameter IS still a breaking change', () => {
    const a = fixture('export function f(x: string): string { return x; }');
    const b = fixture('export function f<T>(x: T): T { return x; }');
    try {
      const sa = extractApiSurfaceWithProgram({ projectRoot: a }).surface;
      const sb = extractApiSurfaceWithProgram({ projectRoot: b }).surface;
      const diff = diffApiSurfaces(sa, sb);
      const sig = diff.entries.find((e) => e.kind === 'signature-changed');
      expect(sig).toBeDefined();
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});
