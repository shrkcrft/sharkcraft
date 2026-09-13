import type { IVerdictCoverage } from './verdict-coverage.ts';

/** How many unexamined labels the gap sentence names before summarising the rest. */
const LABELS_SHOWN = 5;

/**
 * The RAW gap between what a verdict was asked to examine and what it examined,
 * as one sentence — or `undefined` when there is none. Acceptance is ignored
 * here on purpose: this answers "is there a gap?", and
 * {@link coverageShortfall} answers "does the gap veto a clean verdict?".
 * Keeping the two apart is what lets an accepted gap still be printed.
 *
 *   capped         → `capped at 2000 of 2101 files under <root>`
 *   nothing to do  → `0 wiring rules to examine — no wiringRules[] declared`
 *   partial        → `examined 2 of 3 registered tokens, 1 <reason>: C_H`
 */
export function coverageGap(c: IVerdictCoverage): string | undefined {
  const under = c.root ? ` under ${c.root}` : '';
  const why = c.reason ? ` — ${c.reason}` : '';
  if (c.capped === true) {
    return `capped at ${c.examined} of ${c.expected} ${c.unit}${under}${why}`;
  }
  if (c.expected <= 0) {
    return `0 ${c.unit} to examine${under}${why}`;
  }
  if (c.examined >= c.expected) return undefined;
  const labels = c.unexamined ?? [];
  const missing = c.unexaminedTotal ?? (labels.length > 0 ? labels.length : c.expected - c.examined);
  const shown = labels.slice(0, LABELS_SHOWN);
  const more = missing > shown.length && shown.length > 0 ? ` (+${missing - shown.length} more)` : '';
  const named = shown.length > 0 ? `: ${shown.join(', ')}${more}` : '';
  return `examined ${c.examined} of ${c.expected} ${c.unit}${under}, ${missing} ${c.reason ?? 'not examined'}${named}`;
}
