import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ALL_TOOLS } from '../tools/index.ts';
import { PRIMARY_MCP_TOOLS } from '../tools/primary-tools.ts';
import { serializeToolData } from '../server/serialize-tool-data.ts';
import { InMemoryCcrStore, isColumnarTable, expandColumnar } from '@shrkcrft/compress';
import { formatRows, formatObjectArrays, COLUMNAR_LEGEND } from '../server/columnar-format.ts';
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

describe('compression MCP tools', () => {
  test('compress_context + retrieve_original are registered and advertised', () => {
    expect(ALL_TOOLS.some((t) => t.name === 'compress_context')).toBe(true);
    expect(ALL_TOOLS.some((t) => t.name === 'retrieve_original')).toBe(true);
    expect(PRIMARY_MCP_TOOLS.has('compress_context')).toBe(true);
    expect(PRIMARY_MCP_TOOLS.has('retrieve_original')).toBe(true);
  });

  test('descriptions advertise read-only intent', () => {
    expect(tool('compress_context').description.toLowerCase()).toContain('read-only');
    expect(tool('retrieve_original').description.toLowerCase()).toContain('read-only');
  });

  test('compress_context reduces a log; retrieve_original returns the original', async () => {
    const c = ctx();
    const lines: string[] = [];
    for (let i = 0; i < 40; i += 1) lines.push(`INFO step ${i} routine work`);
    lines.push('ERROR boom failure occurred');
    lines.push('Tests: 1 failed, 5 passed');
    const text = lines.join('\n');

    const res = (await tool('compress_context').handler({ content: text }, c)) as IToolResponse;
    const data = res.data as Record<string, unknown>;
    expect(data.tokensSaved as number).toBeGreaterThan(0);
    expect(typeof data.ccrKey).toBe('string');
    expect(String(data.compressed)).toContain('ERROR boom');

    const ret = (await tool('retrieve_original').handler(
      { key: data.ccrKey as string },
      c,
    )) as IToolResponse;
    expect((ret.data as Record<string, unknown>).content).toBe(text);
  });

  test('compress_context on a JSON array is lossless (table, no CCR)', async () => {
    const arr = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, kind: 'rule', title: `T${i}` }));
    const res = (await tool('compress_context').handler(
      { content: JSON.stringify(arr) },
      ctx(),
    )) as IToolResponse;
    const data = res.data as Record<string, unknown>;
    expect(data.lossy).toBe(false);
    expect(data.ccrKey).toBeNull();
    expect(data.strategy).toBe('table');
  });

  test('compress_context with maxTokens unlocks SmartCrusher row-sampling (lossy, retrievable)', async () => {
    const c = ctx();
    // A large homogeneous JSON array whose lossless columnar form still exceeds
    // a tiny token budget — the only path that reaches sampleObjectArray.
    const arr = Array.from({ length: 400 }, (_, i) => ({
      id: `rec-${i}`,
      kind: 'event',
      title: `Telemetry sample number ${i} with some descriptive payload text`,
      score: i,
    }));
    const text = JSON.stringify(arr);

    const res = (await tool('compress_context').handler(
      { content: text, contentType: 'json-array', maxTokens: 50 },
      c,
    )) as IToolResponse;
    const data = res.data as Record<string, unknown>;

    // SmartCrusher ran: lossy sample strategy, with a CCR key + marker.
    expect(data.strategy).toBe('sample');
    expect(data.lossy).toBe(true);
    expect(typeof data.ccrKey).toBe('string');
    expect(String(data.compressed)).toContain(`<<ccr:${data.ccrKey}`);
    expect(data.tokensSaved as number).toBeGreaterThan(0);

    // The original is fully recoverable — via retrieve_original and the store.
    const ret = (await tool('retrieve_original').handler(
      { key: data.ccrKey as string },
      c,
    )) as IToolResponse;
    expect((ret.data as Record<string, unknown>).content).toBe(text);
    expect(c.ccrStore.get(data.ccrKey as string).content).toBe(text);
  });

  test('compress_context with contentType:"source-code" runs the code-outline strategy', async () => {
    const c = ctx();
    // A real-shaped TS module with a meaty function body: the signature/imports
    // are kept and the in-body statements are elided.
    const lines: string[] = ["import { foo } from './foo';", ''];
    lines.push('export function processData(input: number[]): number {');
    for (let i = 0; i < 12; i += 1) {
      lines.push(`  const intermediate${i} = input[${i}] * ${i} + ${i + 1};`);
      lines.push(`  console.log('processing step ${i}', intermediate${i});`);
    }
    lines.push('  let total = 0;');
    lines.push('  for (const v of input) {');
    lines.push('    total += v;');
    lines.push('  }');
    lines.push('  return total;');
    lines.push('}');
    const code = lines.join('\n');

    const res = (await tool('compress_context').handler(
      { content: code, contentType: 'source-code' },
      c,
    )) as IToolResponse;
    const data = res.data as Record<string, unknown>;

    // Routed to compressCode: code-outline strategy, function bodies elided.
    expect(data.contentType).toBe('source-code');
    expect(data.strategy).toBe('code');
    expect(data.lossy).toBe(true);
    expect(data.tokensSaved as number).toBeGreaterThan(0);
    const out = String(data.compressed);
    // Signature + imports kept; body statements elided behind a placeholder.
    expect(out).toContain('export function processData(input: number[]): number {');
    expect(out).toContain('omitted'); // "… N lines omitted …" elision marker
    expect(out).not.toContain("console.log('processing step 5'");
    // Lossy pass cached the original — fully recoverable.
    expect(typeof data.ccrKey).toBe('string');
    const ret = (await tool('retrieve_original').handler(
      { key: data.ccrKey as string },
      c,
    )) as IToolResponse;
    expect((ret.data as Record<string, unknown>).content).toBe(code);
  });

  test('retrieve_original reports a clean cache miss', async () => {
    const res = (await tool('retrieve_original').handler(
      { key: 'deadbeefdeadbeef' },
      ctx(),
    )) as IToolResponse;
    expect(res.isError).toBe(true);
    expect(res.error?.code).toBe('cache-miss');
  });

  test(
    'get_knowledge_graph table format encodes columnar and saves tokens',
    async () => {
      const { inspectSharkcraft } = await import('@shrkcrft/inspector');
      const inspection = await inspectSharkcraft({ cwd: REPO_ROOT });
      const c = ctx({ inspection });
      const t = tool('get_knowledge_graph');
      const jsonRes = (await t.handler({ format: 'json' }, c)) as IToolResponse;
      // format:"json" pins the explicit shape: bare {nodes,edges} (table is the default).
      expect(Object.keys(jsonRes.data as object).sort()).toEqual(['edges', 'nodes']);
      const tableRes = (await t.handler({ format: 'table' }, c)) as IToolResponse;
      const td = tableRes.data as Record<string, unknown>;
      expect(td.format).toBe('table');
      expect(isColumnarTable(td.nodes)).toBe(true);
      const est = td.tokenEstimate as { before: number; after: number };
      expect(est.after).toBeLessThanOrEqual(est.before);
      // The serialized table payload is no larger than the explicit-array one.
      expect(serializeToolData(tableRes.data).length).toBeLessThanOrEqual(
        serializeToolData(jsonRes.data).length,
      );
    },
    30000,
  );
});

describe('list tools columnar format', () => {
  test(
    'list_knowledge format:"table" returns a smaller columnar payload',
    async () => {
      const { inspectSharkcraft } = await import('@shrkcrft/inspector');
      const inspection = await inspectSharkcraft({ cwd: REPO_ROOT });
      const c = ctx({ inspection });
      const t = tool('list_knowledge');
      const def = (await t.handler({ format: 'json' }, c)) as IToolResponse;
      const tab = (await t.handler({ format: 'table' }, c)) as IToolResponse;
      expect(Array.isArray(def.data)).toBe(true);
      const td = tab.data as Record<string, unknown>;
      expect(td.format).toBe('table');
      expect(isColumnarTable(td.items)).toBe(true);
      expect(serializeToolData(tab.data).length).toBeLessThan(serializeToolData(def.data).length);
    },
    30000,
  );
});

describe('formatRows helper', () => {
  // A realistic-sized list, so columnar genuinely beats the bare array + legend
  // (the net-loss guard returns the bare array on small payloads — see below).
  const rows = Array.from({ length: 24 }, (_, i) => ({
    id: `r${i}`,
    kind: 'symbol',
    label: `descriptive label ${i}`,
    area: 'core',
  }));

  test('format:"json" returns the bare array unchanged', () => {
    expect(formatRows(rows, { format: 'json' })).toBe(rows);
  });

  test('format:"table" returns a valid, reconstructable columnar envelope', () => {
    const out = formatRows(rows, { format: 'table' }) as Record<string, unknown>;
    expect(out.format).toBe('table');
    expect(out.legend).toBe(COLUMNAR_LEGEND);
    expect(isColumnarTable(out.items)).toBe(true);
    // Still valid JSON, and reconstructs to the original (incl. array-valued cells).
    const reparsed = JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
    expect(expandColumnar(reparsed.items as never)).toEqual(JSON.parse(JSON.stringify(rows)));
  });

  test('non-compactable input falls back to the bare array', () => {
    const tiny = [{ a: 1 }];
    expect(formatRows(tiny, { format: 'table' })).toBe(tiny);
  });

  test('table is the default; SHRK_MCP_TABLE=0 opts out; explicit format always wins', () => {
    const prev = process.env.SHRK_MCP_TABLE;
    try {
      // Default (flag unset): columnar.
      delete process.env.SHRK_MCP_TABLE;
      expect((formatRows(rows, {}) as Record<string, unknown>).format).toBe('table');
      // Opt out: default reverts to the bare array.
      process.env.SHRK_MCP_TABLE = '0';
      expect(formatRows(rows, {})).toBe(rows);
      // Explicit format:"table" still forces columnar even when opted out.
      expect((formatRows(rows, { format: 'table' }) as Record<string, unknown>).format).toBe('table');
      // Explicit format:"json" still forces the bare array even with the default on.
      delete process.env.SHRK_MCP_TABLE;
      expect(formatRows(rows, { format: 'json' })).toBe(rows);
    } finally {
      if (prev === undefined) delete process.env.SHRK_MCP_TABLE;
      else process.env.SHRK_MCP_TABLE = prev;
    }
  });
});

describe('formatObjectArrays helper', () => {
  const payload = {
    schema: 'x/v1',
    anchor: { id: 'a', kind: 'file' },
    directDependents: Array.from({ length: 20 }, (_, i) => ({ id: `d${i}`, kind: 'file', label: `dependent label ${i}` })),
    transitiveDependents: Array.from({ length: 16 }, (_, i) => ({ id: `t${i}`, kind: 'file', label: `transitive label ${i}` })),
    totalReached: 36,
  };

  test('format:"json" returns the object unchanged', () => {
    expect(formatObjectArrays(payload, { format: 'json' })).toBe(payload);
  });

  test('format:"table" columnarises array fields, preserves scalars, stays valid JSON', () => {
    const out = formatObjectArrays(payload, { format: 'table' }) as Record<string, unknown>;
    expect(out._format).toBe('table');
    expect(out.schema).toBe('x/v1'); // scalar untouched
    expect(out.anchor).toEqual(payload.anchor); // non-array object untouched
    expect(isColumnarTable(out.directDependents)).toBe(true);
    expect(isColumnarTable(out.transitiveDependents)).toBe(true);
    expect(expandColumnar(out.directDependents as never)).toEqual(payload.directDependents);
    JSON.parse(JSON.stringify(out)); // valid JSON
  });

  test('falls back to the original object when no array compacts', () => {
    const small = { a: 1, list: [{ x: 1 }] };
    expect(formatObjectArrays(small, { format: 'table' })).toBe(small);
  });
});

describe('serializeToolData', () => {
  test('minifies by default and preserves shape', () => {
    const data = { a: [1, 2, 3], b: { c: 'd' } };
    const out = serializeToolData(data);
    expect(out).toBe('{"a":[1,2,3],"b":{"c":"d"}}');
    expect(JSON.parse(out)).toEqual(data);
  });

  test('SHRK_MCP_PRETTY restores indentation', () => {
    const prev = process.env.SHRK_MCP_PRETTY;
    process.env.SHRK_MCP_PRETTY = '1';
    try {
      expect(serializeToolData({ a: 1 })).toContain('\n');
    } finally {
      if (prev === undefined) delete process.env.SHRK_MCP_PRETTY;
      else process.env.SHRK_MCP_PRETTY = prev;
    }
  });
});
