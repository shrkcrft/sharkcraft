/**
 * Reversible "derived column" pass for the columnar codec.
 *
 * Many homogeneous object arrays carry columns that are a pure, deterministic
 * function of another column FOR EVERY ROW — e.g. a graph file node where
 * `id === "file:" + path`, `label === basename(path)`, `kind === "file"`.
 * Value-dictionary/columnar encoding can only dedupe the *key* and
 * low-cardinality *values*; it can't recover this per-row derivable content.
 * This pass drops such a column entirely and records how to rebuild it, so
 * {@link reconstructDerived} restores the exact value on decode.
 *
 * Correctness rules:
 *   - CONTENT-checked over every row (never a key-name heuristic) — a column
 *     is only dropped when the transform holds for all rows. Rule/path nodes
 *     where `label` is NOT a function of `id` are left untouched.
 *   - A derived column's base must itself be irreducible (a "base" column), so
 *     decode never chases a dropped column. No cycles, no chains.
 *   - Only fully-present columns (no absent cells) participate, so the `absent`
 *     map never references a dropped column.
 */

export interface IDerivedColumn {
  /** Column to reconstruct on decode. */
  name: string;
  /** Reconstruction op. */
  op: 'const' | 'prefix' | 'basename';
  /** Base column name the value is derived from (op = prefix | basename). */
  from?: string;
  /** Prefix string (op = prefix) or the constant value (op = const). */
  arg?: unknown;
}

export interface IDerivedSplit {
  cols: string[];
  rows: unknown[][];
  absent: Array<[number, number]>;
  derived?: IDerivedColumn[];
}

/** Last path segment (everything after the final `/`), or the whole string. */
function basename(s: string): string {
  const i = s.lastIndexOf('/');
  return i === -1 ? s : s.slice(i + 1);
}

function copy(
  cols: readonly string[],
  rows: readonly unknown[][],
  absent: ReadonlyArray<[number, number]>,
): IDerivedSplit {
  return {
    cols: [...cols],
    rows: rows.map((r) => [...r]),
    absent: absent.map((a) => [a[0], a[1]] as [number, number]),
  };
}

/**
 * Detect and drop derivable columns from a compacted table's raw rows. Returns
 * the reduced cols/rows/absent plus the `derived` reconstruction list (omitted
 * when nothing was dropped). Runs BEFORE value-dictionary encoding so it sees
 * the real values.
 */
export function dropDerivedColumns(
  cols: readonly string[],
  rows: readonly unknown[][],
  absent: ReadonlyArray<[number, number]>,
): IDerivedSplit {
  const n = rows.length;
  // Multi-row only — a single row never pays for the reconstruction metadata.
  if (n < 2 || cols.length < 1) return copy(cols, rows, absent);

  const absentCols = new Set<number>();
  for (const [, c] of absent) absentCols.add(c);
  const present = (c: number): boolean => !absentCols.has(c);
  const val = (r: number, c: number): unknown => rows[r]![c];
  const isStringCol = (c: number): boolean =>
    present(c) && rows.every((row) => typeof row[c] === 'string');

  const dropped = new Set<number>();
  const derived: IDerivedColumn[] = [];

  // 1) Constant columns (every present row holds the same JSON primitive).
  for (let c = 0; c < cols.length; c += 1) {
    if (!present(c)) continue;
    const first = val(0, c);
    if (typeof first === 'object' && first !== null) continue; // only primitives/null
    let allEqual = true;
    for (let r = 1; r < n; r += 1) {
      if (val(r, c) !== first) {
        allEqual = false;
        break;
      }
    }
    if (allEqual) {
      dropped.add(c);
      derived.push({ name: cols[c]!, op: 'const', arg: first });
    }
  }

  // 2) Prefix / basename derivations among the remaining string columns.
  const stringCols: number[] = [];
  for (let c = 0; c < cols.length; c += 1) {
    if (!dropped.has(c) && isStringCol(c)) stringCols.push(c);
  }

  // All valid prefix/basename derivations of column `c` (from every other
  // string column), so we can later prefer one whose base is irreducible.
  const allTransformsOf = (c: number): IDerivedColumn[] => {
    const out: IDerivedColumn[] = [];
    for (const d of stringCols) {
      if (d === c) continue;
      const c0 = val(0, c) as string;
      const d0 = val(0, d) as string;
      // prefix: c === arg + d for all rows (c contains d as a suffix).
      if (c0.endsWith(d0) && c0.length > d0.length) {
        const arg = c0.slice(0, c0.length - d0.length);
        let ok = true;
        for (let r = 0; r < n; r += 1) {
          if ((val(r, c) as string) !== arg + (val(r, d) as string)) {
            ok = false;
            break;
          }
        }
        if (ok) out.push({ name: cols[c]!, op: 'prefix', from: cols[d]!, arg });
      }
      // basename: c === basename(d) for all rows.
      let okB = true;
      for (let r = 0; r < n; r += 1) {
        if ((val(r, c) as string) !== basename(val(r, d) as string)) {
          okB = false;
          break;
        }
      }
      if (okB) out.push({ name: cols[c]!, op: 'basename', from: cols[d]! });
    }
    return out;
  };

  const candidates = new Map<number, IDerivedColumn[]>();
  for (const c of stringCols) candidates.set(c, allTransformsOf(c));
  // A column is a BASE iff it cannot be derived from any other column.
  const baseNames = new Set<string>();
  for (const c of stringCols) if (candidates.get(c)!.length === 0) baseNames.add(cols[c]!);
  // Drop a column only when it can be derived from an irreducible base, so the
  // decoder never chases a dropped column (breaks mutual-derivability cleanly:
  // path stays, id & label derive from it).
  for (const c of stringCols) {
    const pick = candidates.get(c)!.find((t) => t.from && baseNames.has(t.from));
    if (pick) {
      dropped.add(c);
      derived.push(pick);
    }
  }

  if (dropped.size === 0) return copy(cols, rows, absent);

  // Rebuild cols/rows without the dropped columns; remap `absent` col indices
  // (dropped columns carry no absent cells, so none are lost).
  const oldToNew = new Map<number, number>();
  const keptIdx: number[] = [];
  for (let c = 0; c < cols.length; c += 1) {
    if (!dropped.has(c)) {
      oldToNew.set(c, keptIdx.length);
      keptIdx.push(c);
    }
  }
  const newCols = keptIdx.map((c) => cols[c]!);
  const newRows = rows.map((row) => keptIdx.map((c) => row[c]));
  const newAbsent: Array<[number, number]> = [];
  for (const [r, c] of absent) {
    const nc = oldToNew.get(c);
    if (nc !== undefined) newAbsent.push([r, nc]);
  }
  return { cols: newCols, rows: newRows, absent: newAbsent, derived };
}

/** Restore the dropped derived columns onto a decoded object (in place). */
export function reconstructDerived(
  obj: Record<string, unknown>,
  derived: readonly IDerivedColumn[],
): void {
  for (const d of derived) {
    let value: unknown;
    if (d.op === 'const') {
      value = d.arg;
    } else {
      const base = obj[d.from!];
      if (typeof base !== 'string') continue; // base missing/non-string — leave absent
      value = d.op === 'prefix' ? String(d.arg) + base : basename(base);
    }
    Object.defineProperty(obj, d.name, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
}
