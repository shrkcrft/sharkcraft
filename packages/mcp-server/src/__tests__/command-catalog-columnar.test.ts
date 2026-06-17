import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ALL_TOOLS } from '../tools/index.ts';
import { serializeToolData } from '../server/serialize-tool-data.ts';
import { InMemoryCcrStore, isColumnarTable, expandColumnar } from '@shrkcrft/compress';
import type { IToolDefinition, IToolResponse } from '../server/tool-definition.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');

function tool(name: string): IToolDefinition {
  const t = ALL_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ctx(extra: Record<string, unknown> = {}): any {
  return { cwd: REPO_ROOT, inspection: {}, ccrStore: new InMemoryCcrStore(), ...extra };
}

describe('get_command_catalog columnar format', () => {
  test('inputSchema advertises the format property (json|table)', () => {
    const t = tool('get_command_catalog');
    const props = (t.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props.format).toBeDefined();
    expect((props.format as { enum?: unknown[] }).enum).toEqual(['json', 'table']);
  });

  test('format:"json" returns the explicit object/array shape (back-compat)', async () => {
    const t = tool('get_command_catalog');
    const res = (await t.handler({ format: 'json' }, ctx())) as IToolResponse;
    const data = res.data as Record<string, unknown>;
    // entries is a bare explicit array, totals is the untouched scalar object.
    expect(Array.isArray(data.entries)).toBe(true);
    expect((data.entries as unknown[]).length).toBeGreaterThan(0);
    expect((data as { _format?: unknown })._format).toBeUndefined();
    expect(data.totals).toEqual({
      total: (data.entries as unknown[]).length,
      returned: (data.entries as unknown[]).length,
    });
  });

  test('default is table; SHRK_MCP_TABLE=0 reverts to the explicit json shape', async () => {
    const prev = process.env.SHRK_MCP_TABLE;
    try {
      const t = tool('get_command_catalog');
      // Default (flag unset): columnar — matches format:"table".
      delete process.env.SHRK_MCP_TABLE;
      const def = (await t.handler({}, ctx())) as IToolResponse;
      const table = (await t.handler({ format: 'table' }, ctx())) as IToolResponse;
      expect(serializeToolData(def.data)).toBe(serializeToolData(table.data));
      // Opt out: default reverts to the explicit json array shape.
      process.env.SHRK_MCP_TABLE = '0';
      const optedOut = (await t.handler({}, ctx())) as IToolResponse;
      const json = (await t.handler({ format: 'json' }, ctx())) as IToolResponse;
      expect(serializeToolData(optedOut.data)).toBe(serializeToolData(json.data));
    } finally {
      if (prev === undefined) delete process.env.SHRK_MCP_TABLE;
      else process.env.SHRK_MCP_TABLE = prev;
    }
  });

  test('format:"table" columnarises entries, preserves totals, stays smaller', async () => {
    const t = tool('get_command_catalog');
    const jsonRes = (await t.handler({ format: 'json' }, ctx())) as IToolResponse;
    const tableRes = (await t.handler({ format: 'table' }, ctx())) as IToolResponse;
    const td = tableRes.data as Record<string, unknown>;

    // Columnar envelope marker + legend present.
    expect(td._format).toBe('table');
    expect(typeof td._legend).toBe('string');
    // The homogeneous entries array is now a columnar table…
    expect(isColumnarTable(td.entries)).toBe(true);
    // …and reconstructs losslessly back to the explicit array.
    const jsonData = jsonRes.data as Record<string, unknown>;
    expect(expandColumnar(td.entries as never)).toEqual(
      JSON.parse(JSON.stringify(jsonData.entries)),
    );
    // The small `totals` scalar object passes through untouched.
    expect(td.totals).toEqual(jsonData.totals);
    // Still valid JSON.
    JSON.parse(serializeToolData(tableRes.data));
    // Columnar payload is no larger than the explicit-array one.
    expect(serializeToolData(tableRes.data).length).toBeLessThanOrEqual(
      serializeToolData(jsonRes.data).length,
    );
  });
});
