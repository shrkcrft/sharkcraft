/**
 * Does a rule that checked NOTHING count as a failure?
 *
 * A rule whose selector matches nothing enforces nothing, and "enforced
 * nothing" must never read as "passed". `failOnEmpty` controls whether that
 * loud skip is a hard failure (`1`) or an unverified result (`2`).
 *
 * The DEFAULT is on for `error`-severity rules: an error-severity rule exists
 * to block a build, so one that silently matches zero subjects is a bug in the
 * rule, not a pass. `warning`-severity rules default off, because a warning
 * plane legitimately covers sets that may be empty (a stylesheet rule in a repo
 * with no stylesheets). Either default is overridable per rule.
 *
 * Shared by every plane so the semantics cannot drift apart.
 */
export function failsWhenEmpty(rule: {
  readonly failOnEmpty?: boolean;
  readonly severity?: 'error' | 'warning';
}): boolean {
  if (rule.failOnEmpty !== undefined) return rule.failOnEmpty;
  return (rule.severity ?? 'error') === 'error';
}
