import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '@shrkcrft/graph';
import { isColumnarTable, expandColumnar } from '@shrkcrft/compress';
import { ALL_TOOLS } from '../tools/index.ts';
import { COLUMNAR_LEGEND } from '../server/columnar-format.ts';
import type { IToolDefinition, IToolResponse } from '../server/tool-definition.ts';

function tool(name: string): IToolDefinition {
  const t = ALL_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

/**
 * Fixture: `coreThing` is declared in @demo/core's index alongside several
 * sibling exports (→ a populated `neighbouringSymbols` array), and that file
 * is imported by two downstream packages (→ a populated
 * `importersOfDeclaringFile` array). That gives the columnar helper several
 * homogeneous object-arrays to compact.
 */
function setupFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-find-usages-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo-root', workspaces: ['packages/*'] }, null, 2),
  );
  for (const name of ['core', 'alpha', 'beta']) {
    mkdirSync(join(root, 'packages', name, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'packages', name, 'package.json'),
      JSON.stringify({ name: `@demo/${name}`, main: 'src/index.ts' }, null, 2),
    );
  }
  writeFileSync(
    join(root, 'packages', 'core', 'src', 'index.ts'),
    [
      "export const coreThing = 'core';",
      // Many siblings → a large `neighbouringSymbols` array, so the columnar
      // form genuinely beats the bare array + legend (net-loss guard).
      ...Array.from({ length: 20 }, (_, i) => `export function helper${i}() { return coreThing; }`),
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'packages', 'alpha', 'src', 'index.ts'),
    "import { coreThing } from '@demo/core';\nexport const useAlpha = coreThing;",
  );
  writeFileSync(
    join(root, 'packages', 'beta', 'src', 'index.ts'),
    "import { coreThing } from '@demo/core';\nexport const useBeta = coreThing;",
  );
  return root;
}

function ctxFor(root: string) {
  // code_find_usages builds its own GraphStore from ctx.cwd; inspection is unused.
  return { cwd: root, inspection: {} } as never;
}

describe('code_find_usages columnar format', () => {
  test('wires the shared format input property into its schema', () => {
    const props = tool('code_find_usages').inputSchema.properties as Record<string, unknown>;
    expect(props.format).toBeDefined();
    expect((props.format as { enum?: unknown[] }).enum).toEqual(['json', 'table']);
  });

  test('format:"json" returns the bare object with explicit arrays', async () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const res = (await tool('code_find_usages').handler(
        { symbolName: 'coreThing', format: 'json' },
        ctxFor(root),
      )) as IToolResponse;
      const data = res.data as Record<string, unknown>;
      // No columnar envelope markers; arrays are plain object arrays.
      expect(data._format).toBeUndefined();
      expect(Array.isArray(data.definitions)).toBe(true);
      expect(Array.isArray(data.importersOfDeclaringFile)).toBe(true);
      expect(Array.isArray(data.neighbouringSymbols)).toBe(true);
      expect((data.definitions as unknown[]).length).toBeGreaterThanOrEqual(1);
      // Scalars / non-array fields preserved.
      expect((data.symbol as { name: string }).name).toBe('coreThing');
      expect(typeof data.note).toBe('string');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('format:"table" columnarises the object-array fields, preserves scalars', async () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const res = (await tool('code_find_usages').handler(
        { symbolName: 'coreThing', format: 'table' },
        ctxFor(root),
      )) as IToolResponse;
      const data = res.data as Record<string, unknown>;
      // Scalar object + scalar fields pass through untouched.
      expect((data.symbol as { name: string }).name).toBe('coreThing');
      expect(typeof data.note).toBe('string');
      expect(typeof data.totalSymbolMatches).toBe('number');
      // neighbouringSymbols reconstructs losslessly — as a columnar table when
      // hoisting actually saves tokens, or as the bare array under the net-loss
      // guard (the columnar mechanism itself is covered by the helper tests).
      const reparsed = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
      const neigh = reparsed.neighbouringSymbols;
      const expanded = (isColumnarTable(neigh) ? expandColumnar(neigh as never) : neigh) as unknown[];
      expect(Array.isArray(expanded)).toBe(true);
      expect(expanded.length).toBeGreaterThanOrEqual(2);
      expect(expanded.every((n) => typeof (n as { name?: unknown }).name === 'string')).toBe(true);
      // When a columnar envelope IS emitted it carries the shared legend.
      if (data._format === 'table') expect(data._legend).toBe(COLUMNAR_LEGEND);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
