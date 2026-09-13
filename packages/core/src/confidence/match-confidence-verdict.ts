/**
 * The ONE confidence vocabulary shared by every "intent → answer" surface
 * (`shrk recommend`, `shrk reuse`, playbook recommendation).
 *
 * Each surface emits the same four keys beside its results:
 *   - `confident: boolean` — an agent branches on this.
 *   - `verdict: MatchConfidenceVerdict` — the same fact, in words.
 *   - `floor: number` — the bar a candidate had to clear (the unit is the
 *     surface's own score; documented per surface).
 *   - `bestScore: number` — the best candidate's score, confident or not.
 *
 * - `confident`          — at least one candidate cleared the floor.
 * - `no-confident-match` — candidates share terms with the intent, but none
 *   cleared the floor; they are shown as weak suggestions, never as answers.
 * - `no-match`           — nothing shares any term with the intent.
 */
export enum MatchConfidenceVerdict {
  Confident = 'confident',
  NoConfidentMatch = 'no-confident-match',
  NoMatch = 'no-match',
}
