/**
 * THE edit distance: Levenshtein with adjacent transpositions — optimal string
 * alignment (restricted Damerau–Levenshtein). Inserting, deleting or
 * substituting a character, or swapping two ADJACENT characters, each cost 1.
 *
 * Plain Levenshtein charged a transposition 2, and the command-typo tolerance
 * is `max(1, floor(len / 4))`, so a fingers-on-keys swap in a word under 8
 * characters (`chian` → `chain`, `lsit` → `list`, `wirign` → `wiring`) never
 * came within tolerance: the refusal listed the subcommands but named no
 * closest match (round 11 review). The name stays — every "did you mean" in
 * the tree reads this one function. Iterative, three rows of state.
 *
 * Lives in `core` (round 13) so the lowest layer — the `expectEmpty` marker
 * parser — can offer a did-you-mean without importing upward. `@shrkcrft/inspector`
 * re-exports it unchanged from `nearest-id.ts`, and the CLI's `editDistance`
 * is this same function object: still ONE scorer.
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let before: number[] = new Array<number>(n + 1).fill(0);
  let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  let cur: number[] = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, before[j - 2]! + 1);
      }
      cur[j] = d;
    }
    [before, prev, cur] = [prev, cur, before];
  }
  return prev[n]!;
}
