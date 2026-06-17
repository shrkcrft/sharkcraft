import { isColumnarTable } from './columnar-json.ts';

/**
 * A lossily-sampled columnar table. Extends the `_table` envelope (so
 * `expandColumnar` still yields the KEPT rows verbatim) with a `sample` block
 * recording how many rows were dropped and why. The FULL array is recovered
 * from the CCR original, not from this structure.
 */
export interface ISampledTable {
  _table: {
    cols: string[];
    rows: unknown[][];
    absent: Array<[number, number]>;
    /** Per-column value dictionaries (see {@link IColumnarTable}); decode via the same deref. */
    dict?: Record<string, unknown[]>;
    /** Original row count (kept + dropped) — surfaced in the sampling note. */
    n: number;
    sample: {
      kept: number;
      dropped: number;
      anchorsHead: number;
      anchorsTail: number;
      outliers: number;
      matches: number;
      deduped: number;
      /** Original index of each kept row, strictly ascending. */
      srcRows: number[];
      /** Numeric column used for outlier selection, if any. */
      sortField?: string;
    };
  };
}

/** Type guard: a columnar table carrying sampling provenance. */
export function isSampledTable(value: unknown): value is ISampledTable {
  if (!isColumnarTable(value)) return false;
  const t = (value as { _table?: { sample?: unknown } })._table;
  return !!t && typeof t.sample === 'object' && t.sample !== null;
}
