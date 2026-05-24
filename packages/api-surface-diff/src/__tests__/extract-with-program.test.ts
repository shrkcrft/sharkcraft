import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffApiSurfaces, extractApiSurfaceWithProgram } from '../index.ts';

function setupSignaturesFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-api-sig-'));
  mkdirSync(join(root, 'packages', 'lib', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          noEmit: true,
          allowImportingTsExtensions: true,
        },
        include: ['packages/*/src/**/*.ts'],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(root, 'packages', 'lib', 'package.json'),
    JSON.stringify({ name: '@demo/lib', main: 'src/index.ts' }, null, 2),
  );
  writeFileSync(
    join(root, 'packages', 'lib', 'src', 'index.ts'),
    [
      'export function greet(name: string): string {',
      "  return 'hi ' + name;",
      '}',
      '',
      'export interface IUser {',
      '  id: number;',
      '  name: string;',
      '}',
      '',
      "export const VERSION = '1.0';",
    ].join('\n'),
  );
  return root;
}

describe('extractApiSurfaceWithProgram', () => {
  test('captures signatures for exported functions, interfaces, consts', () => {
    const root = setupSignaturesFixture();
    try {
      const r = extractApiSurfaceWithProgram({ projectRoot: root });
      expect(r.surface.total).toBeGreaterThanOrEqual(3);
      const greet = r.surface.symbols.find((s) => s.name === 'greet')!;
      expect(greet).toBeDefined();
      expect(greet.signature).toContain('(name:string)=>string');
      expect(greet.package).toBe('@demo/lib');
      const user = r.surface.symbols.find((s) => s.name === 'IUser')!;
      expect(user).toBeDefined();
      expect(user.signature).toContain('id:number');
      expect(user.signature).toContain('name:string');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('emits diagnostic when no tsconfig is found', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-api-sig-empty-'));
    try {
      const r = extractApiSurfaceWithProgram({ projectRoot: root });
      expect(r.surface.total).toBe(0);
      expect(r.diagnostics.some((d) => d.includes('no tsconfig'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('diffApiSurfaces — signature-change detection', () => {
  test('detects parameter-type change as breaking', () => {
    const root = setupSignaturesFixture();
    try {
      const baseline = extractApiSurfaceWithProgram({ projectRoot: root }).surface;
      // Change `greet(name: string)` to `greet(name: number)`.
      writeFileSync(
        join(root, 'packages', 'lib', 'src', 'index.ts'),
        [
          'export function greet(name: number): string {',
          "  return 'hi ' + name;",
          '}',
          '',
          'export interface IUser {',
          '  id: number;',
          '  name: string;',
          '}',
          '',
          "export const VERSION = '1.0';",
        ].join('\n'),
      );
      const current = extractApiSurfaceWithProgram({ projectRoot: root }).surface;
      const diff = diffApiSurfaces(baseline, current);
      const sigChange = diff.entries.find((e) => e.kind === 'signature-changed' && e.symbol.name === 'greet');
      expect(sigChange).toBeDefined();
      expect(sigChange!.severity).toBe('breaking');
      expect(sigChange!.previous?.signature).toContain('name:string');
      expect(sigChange!.symbol.signature).toContain('name:number');
      expect(diff.breakingCount).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('detects interface member addition as breaking signature change', () => {
    const root = setupSignaturesFixture();
    try {
      const baseline = extractApiSurfaceWithProgram({ projectRoot: root }).surface;
      // Add a required field to IUser.
      writeFileSync(
        join(root, 'packages', 'lib', 'src', 'index.ts'),
        [
          'export function greet(name: string): string {',
          "  return 'hi ' + name;",
          '}',
          '',
          'export interface IUser {',
          '  id: number;',
          '  name: string;',
          '  email: string;',
          '}',
          '',
          "export const VERSION = '1.0';",
        ].join('\n'),
      );
      const current = extractApiSurfaceWithProgram({ projectRoot: root }).surface;
      const diff = diffApiSurfaces(baseline, current);
      const sigChange = diff.entries.find((e) => e.kind === 'signature-changed' && e.symbol.name === 'IUser');
      expect(sigChange).toBeDefined();
      expect(sigChange!.severity).toBe('breaking');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('no signature change when only formatting differs', () => {
    const root = setupSignaturesFixture();
    try {
      const baseline = extractApiSurfaceWithProgram({ projectRoot: root }).surface;
      // Same code, reformatted (extra whitespace).
      writeFileSync(
        join(root, 'packages', 'lib', 'src', 'index.ts'),
        [
          'export   function   greet(name:    string)   :   string   {',
          "    return 'hi ' + name;",
          '}',
          '',
          'export interface IUser {',
          '  id:    number;',
          '  name:  string;',
          '}',
          '',
          "export const VERSION = '1.0';",
        ].join('\n'),
      );
      const current = extractApiSurfaceWithProgram({ projectRoot: root }).surface;
      const diff = diffApiSurfaces(baseline, current);
      const sigChanges = diff.entries.filter((e) => e.kind === 'signature-changed');
      expect(sigChanges.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
