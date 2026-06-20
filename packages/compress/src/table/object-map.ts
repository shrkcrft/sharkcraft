/**
 * Lossless columnar compaction for an OBJECT keyed by id whose values share a
 * schema — a very common API/registry shape (`{ n1:{kind,score}, n2:{…}, … }`)
 * that {@link compactObjectArray} (arrays only) leaves untouched. The shared
 * field names are hoisted out of every entry into `cols`, written once; each
 * entry becomes a positional `rows[i]` aligned to its key in `keys[i]`. Absent
 * keys are tracked in `absent` so `null`-vs-absent round-trips exactly.
 *
 * The encoding is still valid JSON and exactly reconstructable via
 * {@link expandObjectMap}: `null`, absent keys, and all JSON values round-trip
 * exactly. A property whose value is `undefined` is treated as absent — matching
 * `JSON.stringify` and {@link compactObjectArray} — since `undefined` is not a
 * JSON value and cannot survive any JSON envelope. Net-loss is guarded by the
 * caller (`compressJson`).
 */
import {
  isPlainObject,
  buildPresenceMap,
  passesHeterogeneityGate,
  sortColumnsByPresence,
} from './column-presence.ts';

/** Minimum keyed entries before the hoisted schema pays for itself. */
const MIN_ENTRIES = 2;

/** The hoisted form of a homogeneous keyed object. */
export interface IObjectMap {
  /** The map's own keys, in original insertion order. */
  keys: string[];
  /** Hoisted field names, ordered by descending presence then name. */
  cols: string[];
  /** `rows[i][c]` is entry `keys[i]`'s value for `cols[c]` (null when absent). */
  rows: unknown[][];
  /** `[i, c]` pairs whose key was absent on that entry (distinguishes null vs missing). */
  absent: Array<[number, number]>;
}

/**
 * Compact a homogeneous keyed object into a columnar {@link IObjectMap}, or
 * return `null` when it doesn't qualify (not a plain object, too few entries,
 * a non-object value, or too heterogeneous to benefit). Deterministic.
 */
export function compactObjectMap(value: unknown): IObjectMap | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length < MIN_ENTRIES) return null;

  const entries: Record<string, unknown>[] = [];
  for (const key of keys) {
    const v = value[key];
    if (!isPlainObject(v)) return null;
    entries.push(v);
  }

  // Column presence + heterogeneity gate (shared with the array compactor).
  const presence = buildPresenceMap(entries);
  if (!passesHeterogeneityGate(presence, entries.length)) return null;
  const cols = sortColumnsByPresence(presence);

  const rows: unknown[][] = [];
  const absent: Array<[number, number]> = [];
  for (let r = 0; r < entries.length; r += 1) {
    const entry = entries[r]!;
    const row: unknown[] = [];
    for (let c = 0; c < cols.length; c += 1) {
      const key = cols[c]!;
      // Own-property check (not `key in entry`, which walks the prototype chain)
      // so a column named after an Object.prototype member isn't read as a value.
      if (Object.prototype.hasOwnProperty.call(entry, key) && entry[key] !== undefined) {
        row.push(entry[key]);
      } else {
        absent.push([r, c]);
        row.push(null);
      }
    }
    rows.push(row);
  }

  return { keys, cols, rows, absent };
}

/** True when `value` is a `{ _omap: IObjectMap }` envelope. */
export function isObjectMap(value: unknown): value is { _omap: IObjectMap } {
  if (!isPlainObject(value)) return false;
  const m = value._omap;
  return (
    isPlainObject(m) &&
    Array.isArray(m.keys) &&
    Array.isArray(m.cols) &&
    Array.isArray(m.rows) &&
    Array.isArray(m.absent)
  );
}

/**
 * Inverse of {@link compactObjectMap}: rebuild the original keyed object.
 * Accepts either a bare {@link IObjectMap} or a `{ _omap }` envelope. Returns
 * `null` when the input isn't a valid object map.
 */
export function expandObjectMap(value: unknown): Record<string, unknown> | null {
  const map: IObjectMap | undefined = isObjectMap(value)
    ? value._omap
    : isBareObjectMap(value)
      ? value
      : undefined;
  if (!map) return null;

  const absent = new Set(map.absent.map(([r, c]) => `${r},${c}`));
  const out: Record<string, unknown> = {};
  for (let r = 0; r < map.keys.length; r += 1) {
    const obj: Record<string, unknown> = {};
    for (let c = 0; c < map.cols.length; c += 1) {
      if (absent.has(`${r},${c}`)) continue;
      setOwn(obj, map.cols[c]!, map.rows[r]?.[c]);
    }
    setOwn(out, map.keys[r]!, obj);
  }
  return out;
}

/**
 * Assign an own enumerable data property. Plain `obj[key] = value` would invoke
 * the `Object.prototype.__proto__` setter for a column name or map key literally
 * equal to `"__proto__"` (a real own key after `JSON.parse`), silently dropping
 * the value and breaking the lossless round-trip. The array path
 * ({@link expandColumnar}) hardens against this the same way.
 */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function isBareObjectMap(value: unknown): value is IObjectMap {
  return (
    isPlainObject(value) &&
    Array.isArray(value.keys) &&
    Array.isArray(value.cols) &&
    Array.isArray(value.rows) &&
    Array.isArray(value.absent)
  );
}
