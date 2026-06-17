/**
 * Valid-JSON columnar encoding of a compacted table. Unlike the dense text
 * form ({@link renderTable}), this stays parseable JSON — a programmatic
 * client can reconstruct the original objects with {@link expandColumnar} —
 * while still deduplicating the schema out of every row. This is what shrk's
 * MCP tools emit so JSON-parsing agents keep working.
 */
export interface IColumnarTable {
  _table: {
    /** Column names, in schema order. */
    cols: string[];
    /** Row-major values; `rows[r][c]` aligns to `cols[c]`. */
    rows: unknown[][];
    /** `[row, col]` positions whose key was absent on the source object. */
    absent: Array<[number, number]>;
    /**
     * Optional per-column value dictionaries (low-cardinality de-duplication).
     * When a column name is a key here, that column's cells in `rows` are
     * integer indices into `dict[name]` — deref to recover the real value.
     */
    dict?: Record<string, unknown[]>;
  };
}
