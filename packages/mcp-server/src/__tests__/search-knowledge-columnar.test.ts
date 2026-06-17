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

describe('search_knowledge columnar format', () => {
  test('advertises the format input property', () => {
    const props = (tool('search_knowledge').inputSchema as { properties: Record<string, unknown> })
      .properties;
    expect(props.format).toBeDefined();
    expect((props.format as { enum?: unknown[] }).enum).toEqual(['json', 'table']);
  });

  test(
    'format:"json" returns the bare hit array; format:"table" returns a smaller columnar envelope',
    async () => {
      const { inspectSharkcraft } = await import('@shrkcrft/inspector');
      const inspection = await inspectSharkcraft({ cwd: REPO_ROOT });
      const c = ctx({ inspection });
      const t = tool('search_knowledge');

      // Mode-explicit: format:"json" => bare homogeneous array (back-compat wire shape).
      const jsonRes = (await t.handler({ format: 'json', limit: 50 }, c)) as IToolResponse;
      expect(Array.isArray(jsonRes.data)).toBe(true);
      const jsonArr = jsonRes.data as Array<Record<string, unknown>>;
      expect(jsonArr.length).toBeGreaterThan(0);
      expect(jsonArr[0]).toHaveProperty('id');
      expect(jsonArr[0]).toHaveProperty('score');

      // Mode-explicit: format:"table" => columnar envelope { format, legend, items }.
      const tableRes = (await t.handler({ format: 'table', limit: 50 }, c)) as IToolResponse;
      const td = tableRes.data as Record<string, unknown>;
      expect(td.format).toBe('table');
      expect(typeof td.legend).toBe('string');
      expect(isColumnarTable(td.items)).toBe(true);
      // Reconstructs losslessly back to the explicit array (incl. array-valued cells).
      expect(expandColumnar(td.items as never)).toEqual(JSON.parse(JSON.stringify(jsonArr)));
      // The columnar payload serializes no larger than the explicit array.
      expect(serializeToolData(tableRes.data).length).toBeLessThanOrEqual(
        serializeToolData(jsonRes.data).length,
      );
    },
    30000,
  );
});
