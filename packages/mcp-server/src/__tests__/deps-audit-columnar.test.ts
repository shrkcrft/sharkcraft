import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ALL_TOOLS } from '../tools/index.ts';
import { serializeToolData } from '../server/serialize-tool-data.ts';
import { InMemoryCcrStore, isColumnarTable, expandColumnar } from '@shrkcrft/compress';
import { formatObjectArrays, COLUMNAR_LEGEND } from '../server/columnar-format.ts';
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

describe('deps_audit columnar format', () => {
  test('advertises the format input property and table mode in its schema', () => {
    const t = tool('deps_audit');
    expect(t.inputSchema.properties).toHaveProperty('format');
    const fmt = (t.inputSchema.properties as Record<string, unknown>).format as {
      enum?: unknown[];
    };
    expect(fmt.enum).toEqual(['json', 'table']);
    expect(t.description.toLowerCase()).toContain('read-only');
  });

  // Real handler invocation against the repo's own graph index. If the graph
  // index is absent the handler returns a scalar `no-graph` envelope; the
  // wiring (helper + schema) is still proven by the unit test below, so we
  // skip the columnar assertions in that case rather than fail spuriously.
  test(
    'format:"json" returns the bare object; format:"table" columnarises the packages list',
    async () => {
      const c = ctx();
      const t = tool('deps_audit');

      const jsonRes = (await t.handler({ format: 'json' }, c)) as IToolResponse;
      const jd = jsonRes.data as Record<string, unknown>;
      if (jd.error === 'no-graph') {
        // No graph index here — wiring is covered by the unit test below.
        expect(jd.nextCommand).toBe('shrk graph index');
        return;
      }

      // JSON mode: byte-identical to the pre-compression wire shape.
      expect(Object.keys(jd).sort()).toEqual(['packages', 'totals']);
      expect(Array.isArray(jd.packages)).toBe(true);

      const tableRes = (await t.handler({ format: 'table' }, c)) as IToolResponse;
      const td = tableRes.data as Record<string, unknown>;
      if (Array.isArray(jd.packages) && (jd.packages as unknown[]).length >= 2) {
        // Enough rows to compact: expect the columnar envelope.
        expect(td._format).toBe('table');
        expect(td._legend).toBe(COLUMNAR_LEGEND);
        expect(isColumnarTable(td.packages)).toBe(true);
        // Scalar `totals` rides through untouched.
        expect(td.totals).toEqual(jd.totals as Record<string, unknown>);
        // Reconstructs losslessly back to the explicit array.
        const expanded = expandColumnar(td.packages as never) as unknown;
        expect(expanded).toEqual(jd.packages as unknown);
        // Columnar payload is no larger than the explicit-array one.
        expect(serializeToolData(tableRes.data).length).toBeLessThanOrEqual(
          serializeToolData(jsonRes.data).length,
        );
      }
    },
    30000,
  );

  // Mode-explicit wiring unit test on a representative payload of this tool's
  // exact shape ({ totals, packages: IPackageReport[] }). Independent of the
  // graph index so it is robust no matter the environment.
  describe('formatObjectArrays on a representative deps_audit payload', () => {
    // A realistic-sized report list, so the columnar form genuinely beats the
    // bare array + legend (the net-loss guard returns the bare array otherwise).
    const payload = {
      totals: { missing: 3, unused: 2 },
      packages: Array.from({ length: 20 }, (_, i) => ({
        packageName: `@shrkcrft/pkg${i}`,
        packageDir: `packages/pkg${i}`,
        importedSpecifiers: ['@shrkcrft/core', 'zod'],
        missingDeps: [{ specifier: 'left-pad', importedFromCount: i }],
        unusedDeps: [{ specifier: 'lodash', section: 'dependencies' }],
      })),
    };

    test('format:"json" leaves the object byte-identical (back-compat)', () => {
      expect(formatObjectArrays(payload, { format: 'json' })).toBe(payload);
    });

    test('format:"table" columnarises packages, preserves totals, stays valid JSON', () => {
      const out = formatObjectArrays(payload, { format: 'table' }) as Record<string, unknown>;
      expect(out._format).toBe('table');
      expect(out._legend).toBe(COLUMNAR_LEGEND);
      // Scalar object field untouched.
      expect(out.totals).toEqual(payload.totals);
      // Homogeneous report list columnarised + reconstructs losslessly,
      // including the nested per-package string/object arrays.
      expect(isColumnarTable(out.packages)).toBe(true);
      const reparsed = JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
      expect(expandColumnar(reparsed.packages as never)).toEqual(
        JSON.parse(JSON.stringify(payload.packages)),
      );
    });
  });
});
