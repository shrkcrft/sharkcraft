import type { ITableCompaction } from './table-compaction.ts';
import type { IColumnarTable } from './columnar-table.ts';
import { compactObjectArray } from './compact-object-array.ts';
import { applyValueDictionaries } from './apply-value-dictionaries.ts';

/**
 * Encode a compacted table as a valid-JSON columnar object. Only the fields a
 * decoder needs are emitted — `cols`, `rows`, `absent` (and an optional `dict`).
 * The per-column type hints and the source count (== `rows.length`) are
 * encoder-side only and never read off the wire, so they're omitted to save
 * tokens. Low-cardinality columns are value-dictionary encoded (never inflates).
 */
export function tableToColumnar(table: ITableCompaction): IColumnarTable {
  const cols = table.cols.map((c) => c.name);
  const { rows, dict } = applyValueDictionaries(cols, table.rows, table.absent);
  return {
    _table: {
      cols,
      rows,
      absent: table.absent,
      ...(dict ? { dict } : {}),
    },
  };
}

/**
 * Compact an object array straight to columnar JSON, or `null` if it doesn't
 * qualify. Convenience for the common "compact this list for output" path.
 */
export function compactArrayToColumnar(items: unknown): IColumnarTable | null {
  const table = compactObjectArray(items);
  return table ? tableToColumnar(table) : null;
}

/** Type guard: is `value` a columnar table envelope? */
export function isColumnarTable(value: unknown): value is IColumnarTable {
  if (typeof value !== 'object' || value === null) return false;
  const t = (value as { _table?: unknown })._table;
  if (typeof t !== 'object' || t === null) return false;
  const r = t as Record<string, unknown>;
  return (
    Array.isArray(r.cols) &&
    Array.isArray(r.rows) &&
    Array.isArray(r.absent) &&
    (r.dict === undefined ||
      (typeof r.dict === 'object' && r.dict !== null && !Array.isArray(r.dict)))
  );
}

/**
 * Reconstruct the original object array from a columnar envelope. Inverse of
 * {@link tableToColumnar} ∘ {@link compactObjectArray} up to JSON semantics
 * (an absent key stays absent; key order is not significant).
 */
export function expandColumnar(table: IColumnarTable): Array<Record<string, unknown>> {
  const { cols, rows, absent, dict } = table._table;
  const width = cols.length;
  const absentSet = new Set(absent.map(([r, c]) => r * width + c));
  const out: Array<Record<string, unknown>> = [];
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r] ?? [];
    const obj: Record<string, unknown> = {};
    for (let c = 0; c < width; c += 1) {
      if (absentSet.has(r * width + c)) continue;
      const name = cols[c];
      if (name === undefined) continue;
      // A dict-encoded column holds an index into dict[name]; deref it. `hasOwnProperty`
      // (not `in`) so a column literally named "toString" only matches a real own key.
      const raw = row[c];
      const value =
        dict && Object.prototype.hasOwnProperty.call(dict, name)
          ? dict[name]![raw as number]
          : raw;
      // `obj[name] = …` would invoke the Object.prototype `__proto__` setter
      // for a column literally named "__proto__" (a real own key after
      // JSON.parse), silently dropping it and breaking the lossless guarantee.
      // defineProperty always creates an own enumerable data property.
      Object.defineProperty(obj, name, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    out.push(obj);
  }
  return out;
}
