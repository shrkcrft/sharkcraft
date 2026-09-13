/**
 * A verdict after the coverage guard has run — the only shape a verdict verb
 * may render its final line from.
 *
 * `exit` is what the process returns. `shortfalls` are the scope gaps that
 * vetoed (or would have vetoed) a clean verdict; `accepted` are the gaps an
 * explicit acceptance (`--allow-empty`, `registeredExtras`) waived, printed next
 * to the clean sentence so the waiver is never silent. `accepted` is non-empty
 * ONLY when `exit` is `0`: an acceptance is what a clean verdict stands on, and
 * over a 1/2/3 nothing was granted.
 *
 * Lives in core (round 11 review) so an engine below the CLI — the boundary
 * orchestrator that finish, quality and the MCP tools read — settles with the
 * SAME function the CLI's gate envelope does, instead of a second copy that
 * agreed only because a parity test said so.
 */
export interface ISettledVerdict {
  readonly exit: number;
  readonly verdict: 'pass' | 'fail' | 'not-verified' | 'usage-error';
  readonly shortfalls: readonly string[];
  readonly accepted: readonly string[];
}
