import type { INearestId } from './i-nearest-id.ts';
import { levenshtein } from './levenshtein.ts';

/**
 * Nearest-id "did you mean" over an arbitrary id set — the closest ids to
 * `query`, nearest first.
 *
 * The command suggester already had a Levenshtein and a fuzzy ranker, but both
 * were shaped around a command CATALOG (command paths, aliases, descriptions).
 * A stale `nge.angular-renderer` in a doc needs the same help against a flat
 * list of template ids, so the distance function is shared and every caller
 * consumes it — a second implementation would drift, and then two surfaces
 * would disagree about what "close" means.
 *
 * A suggestion is only offered when it is actually close. Printing the
 * alphabetically-first id next to every typo trains people to ignore the line.
 * The cutoff scales with the query's length — one edit is a lot in `foo` and
 * very little in `nge.angular-renderer` — and is capped so a long id cannot
 * drag in something unrelated. Ties break lexically so the output is stable
 * across runs, which matters when it lands in a committed diff.
 *
 * Lives in `core` (round 13) next to {@link levenshtein}; `@shrkcrft/inspector`
 * re-exports both unchanged.
 */
export function nearestIds(
  query: string,
  candidates: readonly string[],
  limit = 3,
): readonly INearestId[] {
  const q = query.toLowerCase();
  const cutoff = Math.min(6, Math.max(2, Math.floor(q.length * 0.4)));
  const scored: INearestId[] = [];
  for (const candidate of candidates) {
    const c = candidate.toLowerCase();
    if (c === q) continue;
    // A shared prefix or suffix is the common real-world shape (`nge.foo-view`
    // vs `nge.foo-viewer`), and raw edit distance under-rates it.
    const affinity = c.startsWith(q) || q.startsWith(c) || c.includes(q) || q.includes(c) ? 0 : 1;
    const distance = affinity === 0 ? 0 : levenshtein(q, c);
    if (distance > cutoff) continue;
    scored.push({ id: candidate, distance });
  }
  return scored
    .sort((x, y) => x.distance - y.distance || x.id.localeCompare(y.id))
    .slice(0, limit);
}
