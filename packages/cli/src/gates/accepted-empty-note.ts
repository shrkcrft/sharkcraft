/**
 * THE printed segment for the rules accepted as intended-empty (round 13, K6):
 * `, M accepted as intended-empty`, appended to a verb's `N of T` evaluated
 * count — the words `check boundaries` prints in its rule list. Such a rule
 * examined 0 files by design, so it is never inside N; it is named apart.
 * Empty when there is none, so a run without a planned rule prints exactly
 * what it printed before.
 */
export function acceptedEmptyNote(count: number | undefined): string {
  return count !== undefined && count > 0 ? `, ${count} accepted as intended-empty` : '';
}
