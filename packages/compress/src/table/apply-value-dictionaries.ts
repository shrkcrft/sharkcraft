/**
 * Per-column value-dictionary (enum) encoding for the columnar table — a
 * lossless token reduction for low-cardinality columns. The columnar form
 * already hoists the schema (column names written once), but a column like the
 * knowledge graph's `kind`/`relation`/`source` still writes its value once per
 * row. This pass replaces those repeats with a one-time dictionary plus a small
 * integer index per row.
 *
 * Disambiguation: a cell is a dict INDEX iff its column name is a key of the
 * returned `dict` (decided structurally, never by the cell's value/type), so a
 * literal-number column and a dict-encoded numeric enum never collide. Absent
 * cells get no index (they stay in `absent` and are skipped before any deref).
 *
 * Pure and deterministic (dict values in first-appearance order). Two guards
 * ensure it NEVER inflates: a per-column byte check, and a table-level byte
 * fallback that returns the dict-free rows when the dict didn't actually shrink.
 */

/** Minimum present cells in a column before a dictionary can pay for itself. */
const MIN_DICT_CELLS = 4;
/** Cheap cap on distinct values; the byte net-check is the real gate. */
const MAX_DICT_CARDINALITY = 64;

export interface IValueDictResult {
  /** Rows with dict-encoded columns rewritten to indices (or the input rows unchanged). */
  rows: unknown[][];
  /** Per-column value tables; present only when at least one column was encoded. */
  dict?: Record<string, unknown[]>;
}

/** Canonical structural identity of a JSON value (absent cells are pre-filtered). */
function canon(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

/**
 * Dictionary-encode every low-cardinality column that strictly shrinks. Returns
 * the (possibly unchanged) rows and an optional `dict`. The input `rows` is
 * never mutated — it is cloned lazily only if a column is encoded.
 */
export function applyValueDictionaries(
  cols: readonly string[],
  rows: readonly unknown[][],
  absent: ReadonlyArray<readonly [number, number]>,
): IValueDictResult {
  const width = cols.length;
  if (width === 0 || rows.length < MIN_DICT_CELLS) return { rows: rows as unknown[][] };

  const absentSet = new Set(absent.map(([r, c]) => r * width + c));
  const dict: Record<string, unknown[]> = {};
  let newRows: unknown[][] | null = null;

  for (let c = 0; c < width; c += 1) {
    const name = cols[c]!;

    // Present cells for this column, ascending row order, with canonical keys.
    const presentRows: number[] = [];
    const presentKeys: string[] = [];
    for (let r = 0; r < rows.length; r += 1) {
      if (absentSet.has(r * width + c)) continue;
      presentRows.push(r);
      presentKeys.push(canon(rows[r]![c]));
    }
    if (presentRows.length < MIN_DICT_CELLS) continue;

    // Intern distinct values in first-appearance order; record each cell's index.
    const indexOf = new Map<string, number>();
    const values: unknown[] = [];
    const indices: number[] = [];
    for (let i = 0; i < presentRows.length; i += 1) {
      const key = presentKeys[i]!;
      let idx = indexOf.get(key);
      if (idx === undefined) {
        idx = values.length;
        indexOf.set(key, idx);
        values.push(rows[presentRows[i]!]![c]);
      }
      indices.push(idx);
    }
    const k = values.length;
    if (k > MAX_DICT_CARDINALITY || k >= presentRows.length) continue;

    // Per-column net check (exact bytes). The rows structure (commas/brackets)
    // is identical either way, so only the per-cell value vs index bytes plus
    // the new `"name":[…]` dict entry matter.
    let inlineBytes = 0;
    let indexBytes = 0;
    for (let i = 0; i < presentRows.length; i += 1) {
      inlineBytes += presentKeys[i]!.length;
      indexBytes += String(indices[i]!).length;
    }
    const dictEntryBytes = JSON.stringify(name).length + JSON.stringify(values).length + 2;
    if (indexBytes + dictEntryBytes >= inlineBytes) continue;

    // Commit: rewrite this column's cells to indices (absent cells → unread 0).
    if (!newRows) newRows = rows.map((row) => row.slice());
    for (let i = 0; i < presentRows.length; i += 1) newRows[presentRows[i]!]![c] = indices[i]!;
    for (let r = 0; r < rows.length; r += 1) if (absentSet.has(r * width + c)) newRows[r]![c] = 0;
    dict[name] = values;
  }

  if (!newRows) return { rows: rows as unknown[][] };

  // Table-level byte fallback: account for the shared `,"dict":{…}` wrapper that
  // the per-column check doesn't. If the dict didn't actually shrink the table,
  // ship the dict-free rows so the encoding can never inflate.
  const withDict = JSON.stringify(newRows).length + JSON.stringify(dict).length + 8;
  if (withDict >= JSON.stringify(rows).length) return { rows: rows as unknown[][] };

  return { rows: newRows, dict };
}
