/**
 * How a construct's NAME matches an intent, by token EQUALITY on the split
 * identifier (never substring): `DateRangePicker` → {date, range, picker}.
 *
 * - `exact`   — the name's token set equals the intent's token set.
 * - `covers`  — every intent token is one of the name's tokens.
 * - `partial` — the two sets intersect.
 * - `none`    — no shared token (`ran` does not match `range`).
 */
export enum ReuseNameMatch {
  Exact = 'exact',
  Covers = 'covers',
  Partial = 'partial',
  None = 'none',
}
