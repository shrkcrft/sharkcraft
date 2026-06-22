import { describe, expect, test } from 'bun:test';
import { compactArrayToColumnar, expandColumnar } from '../index.ts';

function roundTrip(rows: Array<Record<string, unknown>>) {
  const col = compactArrayToColumnar(rows);
  expect(col).not.toBeNull();
  return { col: col!, back: expandColumnar(col!) };
}

describe('derived-column compression', () => {
  test('drops id/kind/label derivable from path on file-node rows, losslessly', () => {
    // Realistic varied directories: `path` is the unique base — `id="file:"+path`
    // (constant "file:" prefix) and `label=basename(path)` derive from it, but
    // `path` is not derivable back (its directory varies per row).
    const dirs = ['packages/core/src', 'packages/cli/src', 'packages/graph/src/indexer', 'apps/web'];
    const rows = Array.from({ length: 50 }, (_, i) => {
      const path = `${dirs[i % dirs.length]}/mod${i}.ts`;
      return { id: `file:${path}`, kind: 'file', label: `mod${i}.ts`, path, line: i + 1 };
    });
    const { col, back } = roundTrip(rows);
    // Lossless round-trip (key order is not significant).
    expect(back).toEqual(rows);
    // The derivable columns were actually dropped, path (the base) kept.
    expect(col._table.cols).not.toContain('id');
    expect(col._table.cols).not.toContain('kind');
    expect(col._table.cols).not.toContain('label');
    expect(col._table.cols).toContain('path');
    expect((col._table.derived ?? []).map((d) => d.name).sort()).toEqual(['id', 'kind', 'label']);
    // Real, large savings vs the raw array.
    const raw = JSON.stringify(rows).length;
    const compact = JSON.stringify(col).length;
    expect(compact).toBeLessThan(raw * 0.6);
  });

  test('content-checked: a column derivable only on SOME rows is kept', () => {
    const rows = [
      { id: 'file:a/b.ts', path: 'a/b.ts', label: 'b.ts' }, // label = basename(path)
      { id: 'file:a/c.ts', path: 'a/c.ts', label: 'renamed' }, // label ≠ basename(path)
    ];
    const { col, back } = roundTrip(rows);
    expect(back).toEqual(rows);
    expect(col._table.cols).toContain('label'); // not derivable for every row
    expect(col._table.cols).not.toContain('id'); // id IS "file:"+path for every row
  });

  test('heterogeneous rows (file + symbol nodes) keep id and kind', () => {
    const rows = [
      { id: 'file:a/b.ts', kind: 'file', path: 'a/b.ts' },
      { id: 'symbol:a/b.ts#Foo', kind: 'symbol', path: 'a/b.ts' },
    ];
    const { col, back } = roundTrip(rows);
    expect(back).toEqual(rows);
    expect(col._table.cols).toContain('id'); // not uniformly "file:"+path
    expect(col._table.cols).toContain('kind'); // varies → not const
  });

  test('reconstructs a constant non-string column (resolved: true)', () => {
    const rows = [
      { path: 'a.ts', resolved: true },
      { path: 'b.ts', resolved: true },
    ];
    const { col, back } = roundTrip(rows);
    expect(back).toEqual(rows);
    expect(col._table.cols).not.toContain('resolved');
  });
});
