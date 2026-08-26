/**
 * Nearest-id "did you mean" over an arbitrary id set.
 *
 * The command suggester already had a Levenshtein and a fuzzy ranker, but both
 * were shaped around a command CATALOG (command paths, aliases, descriptions).
 * A stale `nge.angular-renderer` in a doc needs the same help against a flat
 * list of template ids, so the distance function moves here and both consume
 * it — a second implementation would drift, and then two surfaces would
 * disagree about what "close" means.
 *
 * A suggestion is only offered when it is actually close. Printing the
 * alphabetically-first id next to every typo trains people to ignore the line.
 */

/** Levenshtein edit distance. Iterative, one row of state. */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const tmp = dp[j]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + cost);
      prev = tmp;
    }
  }
  return dp[n]!;
}

/** One candidate the query might have meant. */
export interface INearestId {
  readonly id: string;
  readonly distance: number;
}

/**
 * The closest ids to `query`, nearest first.
 *
 * The cutoff scales with the query's length — one edit is a lot in `foo` and
 * very little in `nge.angular-renderer` — and is capped so a long id cannot
 * drag in something unrelated. Ties break lexically so the output is stable
 * across runs, which matters when it lands in a committed diff.
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
