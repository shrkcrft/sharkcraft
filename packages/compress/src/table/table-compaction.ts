import type { IFieldSpec } from './field-spec.ts';

/**
 * Lossless columnar form of a homogeneous object array. The shared schema is
 * hoisted once into {@link cols}; each row carries only values, positionally.
 * `absent` records `[row, col]` positions whose key was missing on the source
 * object (distinct from a present null) so the original array reconstructs
 * exactly.
 */
export interface ITableCompaction {
  /** Hoisted column schema, in a deterministic order. */
  cols: IFieldSpec[];
  /** Row-major values; `rows[r][c]` aligns to `cols[c]`. */
  rows: unknown[][];
  /** `[row, col]` positions where the source object had no such key. */
  absent: Array<[number, number]>;
  /** Number of source objects (equals `rows.length`). */
  originalCount: number;
}
