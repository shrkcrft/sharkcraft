/**
 * The canonical exit-code contract for every gate / verify / check verb.
 *
 * alpha.24 and alpha.25 made the STDOUT verdicts honest ("not verified",
 * "degraded", "0 rules evaluated", "this is not a pass") but left the exit
 * code returning `0` over those same unverified paths. An agent almost never
 * parses the banner — it chains `shrk <cmd> && <next>` on the *exit code*, so a
 * `0` over a "not verified" result marches straight past the gate. This module
 * is the single source of truth so a chained gate can finally tell apart
 * "passed", "failed", and "never ran".
 *
 *   0  VerifiedPass  — checks ran over a NON-EMPTY scope and passed. Never
 *                      returned when zero units were evaluated.
 *   1  Failure       — checks ran and found violations.
 *   2  NotVerified   — indeterminate: empty evaluation scope, degraded
 *                      fallback, short-circuit, timeout, or "refused to run".
 *                      Distinct from both pass and fail so a chain can branch
 *                      on it (`|| handle-indeterminate`). This is also the
 *                      code the CLI already uses for usage errors — both mean
 *                      "did not produce a verified result".
 *
 * The `gen --typecheck` pre-write gate already refuses-to-nonzero rather than
 * emit an unverified artifact; this generalizes that instinct across the gate
 * surface, adding the third code so "unverified" is distinguishable from
 * "broken".
 */
export enum ExitCode {
  VerifiedPass = 0,
  Failure = 1,
  NotVerified = 2,
}

/**
 * Promote a NotVerified (`2`) exit into a Failure-class nonzero (`1`) when the
 * caller opted into `--strict`. This is the one switch an agent flips to make a
 * hard CI gate treat "unverified" as a failure. Any other code passes through
 * unchanged (a real pass stays `0`, a real failure stays `1`). Applied globally
 * in {@link runCli} after the handler returns, so every gate/verify verb honors
 * `--strict` uniformly without threading the flag through each call site.
 */
export function promoteForStrict(code: number, strict: boolean): number {
  if (strict && code === ExitCode.NotVerified) return ExitCode.Failure;
  return code;
}

/**
 * True when the argv carries a global `--strict` (bare or `--strict=<level>`).
 * `--strict` is also an established per-command flag (e.g. `check --strict`,
 * `doctor --strict=warnings`) whose local meaning is preserved — this global
 * layer only adds the NotVerified→Failure promotion on top, and only affects a
 * command that actually returned `2`.
 */
export function argvHasStrict(argv: readonly string[]): boolean {
  for (const t of argv) {
    if (t === '--') break;
    if (t === '--strict' || t.startsWith('--strict=')) return true;
  }
  return false;
}
