import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeclarationKind, extractDeclarations } from '@shrkcrft/embeddings';

let tempRepo = '';

beforeEach(() => {
  tempRepo = mkdtempSync(join(tmpdir(), 'shrk-extract-'));
});

afterEach(() => {
  rmSync(tempRepo, { recursive: true, force: true });
});

function write(path: string, body: string): string {
  const abs = join(tempRepo, path);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
  return path;
}

describe('extractDeclarations', () => {
  test('captures an interface block with its body, brace-balanced', () => {
    const path = write('a.ts',
      `import x from 'y';\n` +
      `\n` +
      `export interface IFoo {\n` +
      `  name: string;\n` +
      `  bar(n: number): boolean;\n` +
      `}\n` +
      `\n` +
      `export const helper = 1;\n`);
    const blocks = extractDeclarations(tempRepo, path);
    expect(blocks.length).toBe(2);
    const iface = blocks[0]!;
    expect(iface.kind).toBe(DeclarationKind.Interface);
    expect(iface.name).toBe('IFoo');
    expect(iface.snippet).toContain('export interface IFoo');
    expect(iface.snippet).toContain('name: string;');
    expect(iface.snippet).toContain('bar(n: number): boolean;');
    expect(iface.snippet).toContain('}');
  });

  test('captures a type alias and a const signature', () => {
    const path = write('b.ts',
      `export type Result<T> = { ok: true; value: T } | { ok: false; error: Error };\n` +
      `\n` +
      `export const noop = () => undefined;\n`);
    const blocks = extractDeclarations(tempRepo, path);
    expect(blocks.length).toBe(2);
    expect(blocks[0]?.kind).toBe(DeclarationKind.Type);
    expect(blocks[0]?.name).toBe('Result');
    expect(blocks[0]?.snippet).toContain('Result<T>');
    expect(blocks[1]?.kind).toBe(DeclarationKind.Const);
    expect(blocks[1]?.snippet).toContain('export const noop');
  });

  test('captures a class with its body up to the closing brace', () => {
    const path = write('c.ts',
      `export class Foo {\n` +
      `  bar() {\n` +
      `    return 1;\n` +
      `  }\n` +
      `}\n`);
    const blocks = extractDeclarations(tempRepo, path);
    expect(blocks.length).toBe(1);
    expect(blocks[0]?.kind).toBe(DeclarationKind.Class);
    expect(blocks[0]?.name).toBe('Foo');
    // The body is balanced and includes the inner method.
    expect(blocks[0]?.snippet).toContain('bar() {');
    expect(blocks[0]?.snippet.trim().endsWith('}')).toBe(true);
  });

  test('ignores non-export declarations', () => {
    const path = write('d.ts',
      `interface PrivateThing { x: number; }\n` +
      `const internal = 1;\n` +
      `export interface IPublic { y: number; }\n`);
    const blocks = extractDeclarations(tempRepo, path);
    expect(blocks.length).toBe(1);
    expect(blocks[0]?.name).toBe('IPublic');
  });

  test('returns [] when file does not exist', () => {
    expect(extractDeclarations(tempRepo, 'does-not-exist.ts')).toEqual([]);
  });

  test('truncates a block that exceeds the line cap', () => {
    const big =
      'export interface Big {\n' +
      Array.from({ length: 50 }, (_, i) => `  field${i}: string;`).join('\n') +
      '\n}\n';
    const path = write('big.ts', big);
    const blocks = extractDeclarations(tempRepo, path);
    expect(blocks.length).toBe(1);
    expect(blocks[0]?.snippet).toContain('// … (truncated)');
  });
});
