import { compactArrayToColumnar, estimateTokens, EContentType } from '@shrkcrft/compress';

/** Token cost of a value as minified JSON — the shape the wire serializes. */
function jsonTokens(value: unknown): number {
  return estimateTokens(JSON.stringify(value) ?? 'null', EContentType.Json);
}

/**
 * One-line explainer shipped alongside a columnar payload so an agent can decode
 * it. Kept terse on purpose: this string is paid once per columnar response, so
 * a shorter legend is a real per-response token saving — and a smaller fixed
 * cost means the net-loss guard keeps `table` form on more (smaller) payloads.
 */
export const COLUMNAR_LEGEND =
  '_table: rows[i] are values in cols order; absent=[row,col] keys to skip when rebuilding objects. If _table.dict[col] exists, that column’s cells are integer indices into dict[col]. derived[]: columns omitted from cols because each is a function of a kept column — rebuild per op: const->arg; prefix->arg+row[from]; basename->basename(row[from]).';

/** Shared `format` input fragment for list tools that support columnar output. */
export const FORMAT_INPUT_PROPERTY = {
  format: {
    type: 'string' as const,
    enum: ['json', 'table'] as const,
    description:
      'json: explicit object array. table: token-efficient columnar encoding (still valid JSON, schema hoisted, keys deduped) — recommended for large lists. Default is table; set SHRK_MCP_TABLE=0 on the server (or pass format:"json") for the explicit array.',
  },
};

/** Deployment toggle: whether columnar `table` is the default wire shape.
 *  Default ON — every columnar-capable tool emits `table` so agents get the
 *  token savings without asking. Set `SHRK_MCP_TABLE=0` (or `false`/`no`/`off`)
 *  to opt out fleet-wide and restore the explicit-array shape for clients that
 *  need it. `format:"json"` always forces the explicit array per call,
 *  `format:"table"` always forces columnar — both override this default.
 *
 *  Compaction itself is conservative: `compactArrayToColumnar` returns null for
 *  small / heterogeneous arrays, so default-on only reshapes payloads where the
 *  columnar form is an actual win; everything else stays a bare array. */
function tableIsDefault(): boolean {
  const v = (process.env.SHRK_MCP_TABLE ?? '').toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
}

/** Whether a tool should emit columnar for this request. */
export function wantsTable(input: Record<string, unknown>): boolean {
  if (input.format === 'table') return true;
  if (input.format === 'json') return false;
  return tableIsDefault();
}

/**
 * Shape a list tool's homogeneous rows for output. `format:"table"` returns a
 * columnar envelope (`{ format, legend, items }`) — still valid JSON but with
 * the schema hoisted out of every row. Any other value returns the bare array
 * unchanged (back-compat). If the rows don't qualify for compaction, the bare
 * array is returned so callers always get valid data.
 */
export function formatRows(
  rows: ReadonlyArray<Record<string, unknown>>,
  input: Record<string, unknown>,
): unknown {
  if (!wantsTable(input)) return rows;
  const columnar = compactArrayToColumnar(rows as unknown[]);
  if (!columnar) return rows;
  const candidate = { format: 'table', legend: COLUMNAR_LEGEND, items: columnar };
  // Net-loss guard: the legend + envelope can exceed the bare array on a small
  // list. Ship whichever is smaller so `format:"table"` never inflates a payload.
  return jsonTokens(candidate) < jsonTokens(rows) ? candidate : rows;
}

/**
 * Columnar-compact the top-level array fields of a result OBJECT (e.g. a graph
 * query's `{ directDependents: [...], transitiveDependents: [...] }`) when the
 * caller asked for `format:"table"`. Each compactable array becomes a columnar
 * envelope; scalars, small arrays, and heterogeneous arrays are left as-is.
 * Returns the original object unchanged when nothing compacted (back-compat).
 */
export function formatObjectArrays(data: unknown, input: Record<string, unknown>): unknown {
  if (!wantsTable(input) || data === null || typeof data !== 'object' || Array.isArray(data)) {
    return data;
  }
  const src = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let compacted = false;
  for (const [key, value] of Object.entries(src)) {
    if (Array.isArray(value)) {
      const table = compactArrayToColumnar(value);
      // Per-array net-loss guard: only hoist an array whose columnar form is
      // actually smaller — a tiny array loses to its own hoisted schema header.
      if (table && jsonTokens(table) < jsonTokens(value)) {
        out[key] = table;
        compacted = true;
        continue;
      }
    }
    out[key] = value;
  }
  if (!compacted) return data;
  const candidate = { _format: 'table', _legend: COLUMNAR_LEGEND, ...out };
  // Overall net-loss guard: the shared legend must not push the whole payload
  // above the bare object — table mode never inflates (the "never a negative
  // saving" promise the dashboard makes).
  return jsonTokens(candidate) < jsonTokens(data) ? candidate : data;
}
