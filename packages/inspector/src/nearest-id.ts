/**
 * Nearest-id "did you mean" over an arbitrary id set — `levenshtein` (THE edit
 * distance) and `nearestIds` (the length-scaled, affinity-aware cutoff).
 *
 * Round 13: both moved to `@shrkcrft/core` so the lowest layer — the
 * `expectEmpty` marker parser (`normalizeUnitList`) — can offer a did-you-mean
 * for a misspelled marker key without importing upward. This module re-exports
 * them unchanged, so every existing `@shrkcrft/inspector` import keeps working
 * and there is still ONE scorer: the CLI's `editDistance` IS this `levenshtein`
 * (r75-did-you-mean-one-scorer), and a second implementation would drift.
 */
export { levenshtein, nearestIds } from '@shrkcrft/core';
export type { INearestId } from '@shrkcrft/core';
