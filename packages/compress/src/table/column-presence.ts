/**
 * Shared column-presence logic for the homogeneous-shape compactors
 * ({@link compactObjectArray}, {@link compactObjectMap}). Hoisting a schema out
 * of every record only pays off when most columns are present on most records;
 * these pure helpers compute that gate and order the columns deterministically,
 * keeping the threshold tuning in one place.
 */

/** A column is "core" when present on at least this fraction of records. */
const CORE_PRESENCE = 0.8;
/** Compaction only helps when at least this fraction of columns are core. */
const CORE_RATIO = 0.5;

/** True for a plain (non-array, non-null) object — the only shape these compactors hoist. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Count, per key, how many records have it set (undefined counts as absent, per JSON). */
export function buildPresenceMap(
  records: ReadonlyArray<Record<string, unknown>>,
): Map<string, number> {
  const presence = new Map<string, number>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (record[key] === undefined) continue;
      presence.set(key, (presence.get(key) ?? 0) + 1);
    }
  }
  return presence;
}

/**
 * Whether columns are broadly-enough shared that hoisting a schema is worth it:
 * a non-empty presence map where ≥ `CORE_RATIO` of columns are present on ≥
 * `CORE_PRESENCE` of the records.
 */
export function passesHeterogeneityGate(
  presence: Map<string, number>,
  recordCount: number,
): boolean {
  if (presence.size === 0) return false;
  const coreThreshold = recordCount * CORE_PRESENCE;
  let coreCols = 0;
  for (const count of presence.values()) if (count >= coreThreshold) coreCols += 1;
  return coreCols / presence.size >= CORE_RATIO;
}

/** Deterministic column order: most-present first, ties broken by name. */
export function sortColumnsByPresence(presence: Map<string, number>): string[] {
  return [...presence.keys()].sort((a, b) => {
    const pa = presence.get(a) ?? 0;
    const pb = presence.get(b) ?? 0;
    if (pa !== pb) return pb - pa;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
