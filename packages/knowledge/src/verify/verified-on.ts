/**
 * `verifiedOn` date arithmetic — done here and nowhere else.
 *
 * `verifiedOn` is AUTHOR ATTESTATION: the day someone last checked an entry's
 * claims against the code. It is not index freshness (freshness is divergence,
 * never age — `detectGraphFreshness` owns that), so age here is only ever a
 * triage signal: "everything not verified in N months" is the most useful query
 * against a rotting corpus, and the only age signal before this field was
 * whatever an author typed into the body text.
 *
 * The validator, the entry formatter and the staleness sweep all read these
 * functions, so "is this a date", "how old is it" and "what does 6m mean" have
 * one answer each.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;
const DURATION = /^(\d+)([dwmy])$/;
const UNIT_DAYS: Readonly<Record<string, number>> = { d: 1, w: 7, m: 30, y: 365 };

/** True when `value` is a real calendar date written `YYYY-MM-DD` (so `2026-02-30` is not). */
export function isValidVerifiedOn(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === value;
}

/** Today's date in UTC, `YYYY-MM-DD` — the default `asOf`, echoed wherever it is used. */
export function todayUtcIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Whole days from `verifiedOn` to `asOf` (both `YYYY-MM-DD`). Negative when
 * `verifiedOn` is after `asOf`; `undefined` when either is not a valid date.
 */
export function verifiedOnAgeDays(verifiedOn: string, asOf: string): number | undefined {
  if (!isValidVerifiedOn(verifiedOn) || !isValidVerifiedOn(asOf)) return undefined;
  return Math.round(
    (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${verifiedOn}T00:00:00Z`)) / MS_PER_DAY,
  );
}

/**
 * Parse a `--stale-after` duration — `90d`, `12w`, `6m` (30 days), `1y` (365
 * days) — into days. Returns `null` for anything else, including `0`, so a
 * malformed value is a usage error rather than a silently-empty filter.
 */
export function parseStaleAfterDays(raw: string): number | null {
  const m = DURATION.exec(raw.trim().toLowerCase());
  if (!m) return null;
  const n = Number(m[1]);
  const days = n * (UNIT_DAYS[m[2]!] ?? 0);
  return Number.isInteger(days) && days > 0 ? days : null;
}
