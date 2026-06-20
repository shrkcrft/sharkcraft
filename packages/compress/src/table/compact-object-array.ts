import type { IFieldSpec } from './field-spec.ts';
import type { ITableCompaction } from './table-compaction.ts';
import {
  isPlainObject,
  buildPresenceMap,
  passesHeterogeneityGate,
  sortColumnsByPresence,
} from './column-presence.ts';

/** Minimum rows before a table is worth its schema header. */
const MIN_ROWS = 2;

function inferType(values: readonly unknown[]): string {
  let sawNonNull = false;
  let allBool = true;
  let allInt = true;
  let allNumber = true;
  let allString = true;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    sawNonNull = true;
    if (typeof v !== 'boolean') allBool = false;
    if (typeof v !== 'number') {
      allInt = false;
      allNumber = false;
    } else if (!Number.isInteger(v)) {
      allInt = false;
    }
    if (typeof v !== 'string') allString = false;
  }
  if (!sawNonNull) return 'null';
  if (allBool) return 'bool';
  if (allInt) return 'int';
  if (allNumber) return 'float';
  if (allString) return 'str';
  return 'json';
}

/**
 * Compact a homogeneous array of objects into a lossless columnar table.
 * Returns `null` when the input doesn't qualify (too few rows, non-objects,
 * or too heterogeneous to benefit). A JSON value (`undefined` treated as an
 * absent key, matching JSON semantics) round-trips exactly through
 * {@link expandColumnar}.
 *
 * Deterministic: columns are ordered by descending presence, then by name.
 */
export function compactObjectArray(items: unknown): ITableCompaction | null {
  if (!Array.isArray(items) || items.length < MIN_ROWS) return null;
  for (const item of items) if (!isPlainObject(item)) return null;
  const rowsIn = items as Array<Record<string, unknown>>;

  // Column presence + heterogeneity gate (shared with the object-map compactor).
  const presence = buildPresenceMap(rowsIn);
  if (!passesHeterogeneityGate(presence, rowsIn.length)) return null;
  const colNames = sortColumnsByPresence(presence);

  const rows: unknown[][] = [];
  const absent: Array<[number, number]> = [];
  for (let r = 0; r < rowsIn.length; r += 1) {
    const item = rowsIn[r]!;
    const row: unknown[] = [];
    for (let c = 0; c < colNames.length; c += 1) {
      const key = colNames[c]!;
      // `key in item` walks the prototype chain, so a column named after an
      // Object.prototype member (`toString`, `hasOwnProperty`, …) would read the
      // inherited member as a cell value. Own-property check keeps it lossless.
      const present = Object.prototype.hasOwnProperty.call(item, key) && item[key] !== undefined;
      if (!present) {
        absent.push([r, c]);
        row.push(null);
      } else {
        row.push(item[key]);
      }
    }
    rows.push(row);
  }

  const cols: IFieldSpec[] = colNames.map((name, c) => {
    const columnValues = rows.map((row) => row[c]);
    const presentCount = presence.get(name) ?? 0;
    const hasNull = columnValues.some((v) => v === null);
    return {
      name,
      type: inferType(columnValues),
      nullable: presentCount < rowsIn.length || hasNull,
    };
  });

  return { cols, rows, absent, originalCount: rowsIn.length };
}
