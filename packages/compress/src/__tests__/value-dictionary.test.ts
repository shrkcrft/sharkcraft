import { describe, expect, test } from 'bun:test';
import {
  compactObjectArray,
  compactArrayToColumnar,
  expandColumnar,
  isColumnarTable,
  isSampledTable,
  sampleObjectArray,
  estimateTokens,
  EContentType,
  columnarToCsv,
  csvToObjects,
  columnarToMarkdownKv,
  markdownKvToObjects,
  type IColumnarTable,
} from '../index.ts';

/** Bare columnar (no value dictionaries) for before/after token comparison. */
function bareColumnar(arr: unknown[]): IColumnarTable {
  const t = compactObjectArray(arr)!;
  return { _table: { cols: t.cols.map((c) => c.name), rows: t.rows, absent: t.absent } };
}

function jtok(value: unknown): number {
  return estimateTokens(JSON.stringify(value), EContentType.Json);
}

/** Deterministic LCG for reproducible fuzz. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

describe('value-dictionary columnar encoding', () => {
  test('encodes a low-cardinality column; round-trips with present-null vs absent', () => {
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 20; i += 1) {
      const o: Record<string, unknown> = { id: `n${i}`, kind: i % 2 === 0 ? 'file' : 'symbol' };
      if (i === 7) o.kind = null; // present null
      if (i === 11) delete o.kind; // absent key
      rows.push(o);
    }
    const table = compactArrayToColumnar(rows)!;
    // Low-cardinality `kind` is dict-encoded; high-cardinality `id` is not.
    expect(table._table.dict).toBeDefined();
    expect(table._table.dict!.kind).toEqual(['file', 'symbol', null]); // first-appearance order
    expect(table._table.dict!.id).toBeUndefined();

    const back = expandColumnar(table);
    expect(back).toEqual(rows.map((r) => JSON.parse(JSON.stringify(r))) as never);
    // null-vs-absent preserved.
    expect('kind' in back[7]!).toBe(true);
    expect(back[7]!.kind).toBeNull();
    expect('kind' in back[11]!).toBe(false);
  });

  test('fuzz: round-trip holds for mixed dict / non-dict / nested / null / absent columns', () => {
    for (const seed of [1, 7, 42, 1337, 90210]) {
      const rng = makeRng(seed);
      const n = 10 + Math.floor(rng() * 40);
      const arr: Array<Record<string, unknown>> = [];
      for (let i = 0; i < n; i += 1) {
        const o: Record<string, unknown> = {
          id: `id-${i}-${Math.floor(rng() * 1e6)}`, // high-card → must NOT dict
          kind: ['file', 'symbol', 'rule'][i % 3], // low-card string → SHOULD dict
          score: Math.round(rng() * 1000) / 100, // numeric literal
          tag: rng() > 0.5 ? { area: 'core', deep: [1, 2] } : { area: 'api', deep: [1, 2] }, // low-card nested
        };
        if (rng() > 0.85) o.kind = null; // present null
        if (rng() > 0.9) delete o.score; // absent key
        arr.push(o);
      }
      const table = compactArrayToColumnar(arr);
      if (!table) continue;
      expect(expandColumnar(table)).toEqual(arr.map((r) => JSON.parse(JSON.stringify(r))) as never);
    }
  });

  test('deterministic: same input → same bytes; dict order is first-appearance', () => {
    const arr = Array.from({ length: 12 }, (_, i) => ({ id: `x${i}`, type: i < 5 ? 'beta' : 'alpha' }));
    const a = JSON.stringify(compactArrayToColumnar(arr));
    const b = JSON.stringify(compactArrayToColumnar(arr));
    expect(a).toBe(b);
    // 'beta' appears first → index 0.
    expect(compactArrayToColumnar(arr)!._table.dict!.type).toEqual(['beta', 'alpha']);
  });

  test('never inflates: dict only when it shrinks; high-card stays literal; tiny stays bare', () => {
    // All-distinct column → no dict (would not save).
    const distinct = Array.from({ length: 20 }, (_, i) => ({ id: `u${i}`, label: `unique-${i}` }));
    const dt = compactArrayToColumnar(distinct)!;
    expect(dt._table.dict).toBeUndefined();

    // Tiny array → identical to the bare columnar (no dict field).
    const tiny = [{ a: 'x', b: 1 }, { a: 'x', b: 2 }];
    const tt = compactArrayToColumnar(tiny);
    if (tt) expect(tt._table.dict).toBeUndefined();

    // Low-card array → dict form is no larger than bare, and strictly smaller here.
    const enumArr = Array.from({ length: 60 }, (_, i) => ({
      id: `n${i}`,
      kind: ['file', 'symbol', 'rule'][i % 3],
      area: ['core', 'api', 'ui'][i % 3],
    }));
    const dict = compactArrayToColumnar(enumArr)!;
    expect(jtok(dict)).toBeLessThan(jtok(bareColumnar(enumArr)));
  });

  test('CSV / Markdown-KV deref dict indices to real values (no index leaks)', () => {
    const arr = Array.from({ length: 16 }, (_, i) => ({
      id: `n${i}`,
      kind: i % 2 === 0 ? 'file' : 'symbol',
      status: i % 2 === 0 ? 100 : 200, // numeric enum → dict, but text must show 100/200 not 0/1
    }));
    const table = compactArrayToColumnar(arr)!;
    expect(table._table.dict!.kind).toBeDefined();

    const csv = columnarToCsv(table);
    expect(csv).toContain('"file"'); // real value, not an index
    expect(csv).toContain('100'); // real numeric value, not the index 0
    expect(csvToObjects(csv)).toEqual(expandColumnar(table));

    const md = columnarToMarkdownKv(table);
    expect(md).toContain('"file"');
    expect(markdownKvToObjects(md)).toEqual(expandColumnar(table));
  });

  test('guards: dict envelope passes isColumnarTable; malformed dict rejected; legacy passes', () => {
    const arr = Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, kind: i % 2 ? 'a' : 'b' }));
    const table = compactArrayToColumnar(arr)!;
    expect(isColumnarTable(table)).toBe(true);
    // Legacy (no dict) still valid.
    expect(isColumnarTable({ _table: { cols: ['a'], rows: [[1]], absent: [] } })).toBe(true);
    // Malformed dict rejected.
    expect(isColumnarTable({ _table: { cols: ['a'], rows: [[1]], absent: [], dict: [] } })).toBe(false);
    expect(isColumnarTable({ _table: { cols: ['a'], rows: [[1]], absent: [], dict: 'x' } })).toBe(false);
  });

  test('the SmartCrusher sampler dict-encodes kept rows and they expand exactly', () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({
      id: `n${i}`,
      kind: ['file', 'symbol', 'rule'][i % 3], // low-card → dict on the kept rows
      score: i % 10,
    }));
    const sampled = sampleObjectArray(rows, { maxItems: 20 })!;
    expect(isSampledTable(sampled)).toBe(true);
    expect(sampled._table.dict!.kind).toBeDefined();
    // Every kept row reconstructs to a real object (indices dereferenced, not left as 0/1/2).
    const expanded = expandColumnar(sampled);
    expect(expanded.length).toBe(sampled._table.rows.length);
    expect(expanded.every((o) => ['file', 'symbol', 'rule'].includes(o.kind as string))).toBe(true);
    expect(expanded.every((o) => typeof o.id === 'string' && typeof o.score === 'number')).toBe(true);
  });

  test('graph-shaped fixture: dict applied to enum columns, ≥15% below bare columnar', () => {
    const KINDS = ['knowledge', 'rule', 'path', 'template', 'pipeline', 'preset', 'pack', 'boundary', 'doc'];
    const SOURCES = ['builtin', 'local', 'pack:core', 'pack:web'];
    const nodes = Array.from({ length: 200 }, (_, i) => ({
      id: `node-${i}`,
      kind: KINDS[i % KINDS.length],
      title: `Title for asset number ${i}`,
      source: SOURCES[i % SOURCES.length],
    }));
    const table = compactArrayToColumnar(nodes)!;
    // Enum columns dict-encoded; identity columns not.
    expect(table._table.dict!.kind).toBeDefined();
    expect(table._table.dict!.source).toBeDefined();
    expect(table._table.dict!.id).toBeUndefined();
    expect(table._table.dict!.title).toBeUndefined();
    // Reconstructs exactly.
    expect(expandColumnar(table)).toEqual(nodes.map((n) => JSON.parse(JSON.stringify(n))) as never);
    // Materially smaller than the bare columnar form.
    const reduction = 1 - jtok(table) / jtok(bareColumnar(nodes));
    expect(reduction).toBeGreaterThanOrEqual(0.15);
  });
});
