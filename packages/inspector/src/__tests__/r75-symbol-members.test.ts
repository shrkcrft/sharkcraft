/**
 * Round 11, 4.1(b) — class / interface / enum / namespace / object-literal
 * members are addressable as `Owner.member`.
 *
 * The symbol index walked top-level statements only, so a reference naming a
 * method that plainly exists reported "not declared" forever, and the only
 * escape was coarsening it to the whole file. Members are now indexed one level
 * deep — additively: the export / local / re-export sets the graph indexer
 * reads are unchanged.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSymbolIndex, resolveSymbolInFile, SymbolResolution } from '../symbol-index.ts';
import { SymbolMemberKind } from '../symbol-member-kind.ts';

const root = mkdtempSync(join(tmpdir(), 'shrk-r75-members-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SRC = `export class Foo {
  static create(): Foo { return new Foo(); }
  bar(): number { return 1; }
  private baz = 2;
  get size(): number { return 3; }
}
export interface IShape { width: number; area(): number; }
export enum Color { Red, Green }
export namespace Ns { export const inner = 1; export function helper(): void {} }
export const CONFIG = { alpha: 1, beta() { return 2; } } as const;
const local = { gamma: 3 };
`;
const file = join(root, 'foo.ts');
writeFileSync(file, SRC);
const reexport = join(root, 'barrel.ts');
writeFileSync(reexport, "export { Foo } from './foo';\n");

describe('buildSymbolIndex collects members one level deep', () => {
  const idx = buildSymbolIndex(file);
  const has = (owner: string, name: string, kind: SymbolMemberKind, isStatic = false): void => {
    expect(idx.members?.find((m) => m.owner === owner && m.name === name)).toMatchObject({ kind, static: isStatic });
  };

  test('class methods (static too), properties and accessors', () => {
    has('Foo', 'create', SymbolMemberKind.Method, true);
    has('Foo', 'bar', SymbolMemberKind.Method);
    has('Foo', 'baz', SymbolMemberKind.Property);
    has('Foo', 'size', SymbolMemberKind.Accessor);
  });

  test('interface, enum, namespace and object-literal members', () => {
    has('IShape', 'width', SymbolMemberKind.InterfaceMember);
    has('IShape', 'area', SymbolMemberKind.InterfaceMember);
    has('Color', 'Red', SymbolMemberKind.EnumMember);
    has('Ns', 'inner', SymbolMemberKind.NamespaceMember);
    has('Ns', 'helper', SymbolMemberKind.NamespaceMember);
    has('CONFIG', 'alpha', SymbolMemberKind.ObjectKey);
    has('CONFIG', 'beta', SymbolMemberKind.ObjectKey);
    has('local', 'gamma', SymbolMemberKind.ObjectKey);
  });

  test('the top-level sets the graph reads are unchanged (members never leak into exports)', () => {
    expect(idx.exports.map((e) => e.name).sort()).toEqual(['CONFIG', 'Color', 'Foo', 'IShape', 'Ns']);
    expect(idx.locals.map((e) => e.name)).toEqual(['local']);
  });
});

describe('resolveSymbolInFile — Owner.member', () => {
  test('an exported owner\'s member is an exact member; .prototype. is accepted', () => {
    expect(resolveSymbolInFile(file, 'Foo.bar').resolution).toBe(SymbolResolution.ExactMember);
    expect(resolveSymbolInFile(file, 'Foo.prototype.bar').resolution).toBe(SymbolResolution.ExactMember);
    expect(resolveSymbolInFile(file, 'Color.Green').resolution).toBe(SymbolResolution.ExactMember);
    expect(resolveSymbolInFile(file, 'local.gamma').resolution).toBe(SymbolResolution.ExactLocalMember);
  });

  test('the resolved span is the member declaration, not the file', () => {
    const r = resolveSymbolInFile(file, 'Foo.bar');
    expect(SRC.slice(r.span!.start, r.span!.end)).toBe('bar(): number { return 1; }');
  });

  test('a missing member names what the owner DOES have', () => {
    const r = resolveSymbolInFile(file, 'Foo.nope');
    expect(r.resolution).toBe(SymbolResolution.Missing);
    expect(r.message).toContain('its members: create, bar, baz, size');
  });

  test('a bare member name stays Missing — but routes the author to Owner.member', () => {
    const r = resolveSymbolInFile(file, 'bar');
    expect(r.resolution).toBe(SymbolResolution.Missing);
    expect(r.message).toContain('pin it as `Foo.bar`');
    expect(r.suggestedSymbol).toBe('Foo.bar');
  });

  test('a re-exported owner is never a false Ok — its members live elsewhere', () => {
    const r = resolveSymbolInFile(reexport, 'Foo.bar');
    expect(r.resolution).toBe(SymbolResolution.Unknown);
    expect(r.message).toContain('pin the declaring file');
  });
});
