import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IRegistryDeclaration } from '@shrkcrft/core';
import { scanRegistry, registryExists, registryWhere } from '../wiring/registry-query.ts';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'shrk-registry-'));
  mkdirSync(join(root, 'commands'), { recursive: true });
  writeFileSync(join(root, 'commands', 'a.command.ts'), `export const fooCommand = { name: 'foo' };\n`);
  writeFileSync(join(root, 'commands', 'b.command.ts'), `export const barCommand = { name: 'bar' };\n`);
  // A consumer/binding file that wires only 'foo'.
  mkdirSync(join(root, 'wire'), { recursive: true });
  writeFileSync(join(root, 'wire', 'main.ts'), `register('foo');\n`);
  // An inline array-literal registry.
  writeFileSync(join(root, 'plugins.ts'), `export const PLUGINS = ['alpha', 'beta', 'gamma'];\n`);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const commandsDecl: IRegistryDeclaration = {
  name: 'commands',
  source: { files: ['commands/*.command.ts'], pattern: "name:\\s*'([a-z]+)'" },
  consumer: { files: ['wire/*.ts'], pattern: "register\\('([a-z]+)'\\)" },
};

describe('scanRegistry — pattern source', () => {
  test('lists every declared id, sorted, with sites', () => {
    const inv = scanRegistry(root, commandsDecl);
    expect(inv.entries.map((e) => e.id)).toEqual(['bar', 'foo']);
    const foo = registryWhere(inv, 'foo');
    expect(foo?.sites[0]?.file).toBe('commands/a.command.ts');
    expect(foo?.sites[0]?.line).toBe(1);
    expect(inv.diagnostics).toEqual([]);
  });

  test('exists answers hard yes/no against ground truth', () => {
    const inv = scanRegistry(root, commandsDecl);
    expect(registryExists(inv, 'foo')).toBe(true);
    expect(registryExists(inv, 'bar')).toBe(true);
    expect(registryExists(inv, 'missing')).toBe(false);
  });

  test('where surfaces the declaration AND the consumer/binding site', () => {
    const inv = scanRegistry(root, commandsDecl);
    const foo = registryWhere(inv, 'foo');
    expect(foo?.consumerSites?.[0]?.file).toBe('wire/main.ts');
    // 'bar' is declared but never wired — no consumer site.
    const bar = registryWhere(inv, 'bar');
    expect(bar?.consumerSites).toBeUndefined();
  });
});

describe('scanRegistry — arrayProperty source', () => {
  test('harvests ids from an inline/exported array literal', () => {
    const inv = scanRegistry(root, {
      name: 'plugins',
      source: { files: ['plugins.ts'], arrayProperty: 'PLUGINS' },
    });
    expect(inv.entries.map((e) => e.id)).toEqual(['alpha', 'beta', 'gamma']);
    expect(registryExists(inv, 'beta')).toBe(true);
    expect(registryExists(inv, 'delta')).toBe(false);
  });
});

describe('scanRegistry — misconfiguration', () => {
  test('a source with neither pattern nor arrayProperty degrades to a diagnostic', () => {
    const inv = scanRegistry(root, { name: 'broken', source: { files: ['commands/*.ts'] } });
    expect(inv.entries).toEqual([]);
    expect(inv.diagnostics.length).toBeGreaterThan(0);
  });
});
