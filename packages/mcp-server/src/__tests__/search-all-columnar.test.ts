import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ALL_TOOLS } from '../tools/index.ts';
import { serializeToolData } from '../server/serialize-tool-data.ts';
import { InMemoryCcrStore, isColumnarTable } from '@shrkcrft/compress';
import { COLUMNAR_LEGEND } from '../server/columnar-format.ts';
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

describe('search_all columnar format', () => {
  test('advertises the format input property', () => {
    const props = tool('search_all').inputSchema.properties as Record<string, unknown>;
    expect(props.format).toBeDefined();
    expect((props.format as { enum?: unknown[] }).enum).toEqual(['json', 'table']);
  });

  test(
    'format:"json" returns the byte-identical bare object; format:"table" columnarises hits',
    async () => {
      const { inspectSharkcraft } = await import('@shrkcrft/inspector');
      const inspection = await inspectSharkcraft({ cwd: REPO_ROOT });
      const c = ctx({ inspection });
      const t = tool('search_all');

      // MODE-EXPLICIT json: bare {query,total,truncated,hits}, hits is a real array.
      const jsonRes = (await t.handler({ query: 'rule', limit: 30, format: 'json' }, c)) as IToolResponse;
      const jd = jsonRes.data as Record<string, unknown>;
      expect(Object.keys(jd).sort()).toEqual(['hits', 'query', 'total', 'truncated']);
      expect(Array.isArray(jd.hits)).toBe(true);
      expect((jd.hits as unknown[]).length).toBeGreaterThan(0);

      // MODE-EXPLICIT table: columnar envelope, scalars preserved, hits columnar.
      const tableRes = (await t.handler({ query: 'rule', limit: 30, format: 'table' }, c)) as IToolResponse;
      const td = tableRes.data as Record<string, unknown>;
      expect(td._format).toBe('table');
      expect(td._legend).toBe(COLUMNAR_LEGEND);
      expect(td.query).toBe(jd.query); // scalar untouched
      expect(td.total).toBe(jd.total); // scalar untouched
      expect(td.truncated).toBe(jd.truncated); // scalar untouched
      expect(isColumnarTable(td.hits)).toBe(true);

      // The columnar payload is no larger than the explicit-array one.
      expect(serializeToolData(tableRes.data).length).toBeLessThanOrEqual(
        serializeToolData(jsonRes.data).length,
      );
    },
    60000,
  );
});
