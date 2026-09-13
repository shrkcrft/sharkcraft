import type { IUnitStateNotes } from './i-unit-state-notes.ts';

/**
 * A verb's clean sentence, qualified by THE shared unit-state renderer's
 * findings (round 13, K2): with a dead unit or a LOCAL went-live marker listed
 * above, EVERY ✓ is withheld and the sentence says why — `No policy
 * violations on the scanned surfaces, but 1 expectEmpty unit(s) went live —
 * remove the markers (listed above).` The exit is unchanged (advisory);
 * `verdictLine` still prints the sentence only at exit 0, followed by any
 * acceptance. An empty `clean` stays empty.
 */
export function qualifyCleanForUnits(clean: string, notes: IUnitStateNotes): string {
  if (clean.length === 0 || notes.stale.length === 0) return clean;
  const lead = clean
    .replace(/\s*✓/gu, '')
    .replace(/ {2,}/gu, ' ')
    .replace(/[.\s]+$/u, '');
  return `${lead}, but ${notes.stale.join(', and ')} (listed above).`;
}
