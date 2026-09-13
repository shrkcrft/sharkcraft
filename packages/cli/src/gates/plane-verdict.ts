import { ExitCode } from '../exit-codes.ts';

/**
 * A plane payload's top-level `verdict`, derived from the SETTLED exit — so a
 * `--json` payload can never say `pass` (or `warnings`) next to `exitCode: 2`.
 *
 *   0 → `warnings` when the engine reported non-blocking findings, else `pass`
 *   1 → `errors`
 *   2 → `not-verified`
 *   3 → `usage-error`
 *
 * Spread the engine's report first and set `verdict: planeVerdictForExit(exit,
 * report.verdict)` after it, so the settled word overrides the engine's.
 */
export function planeVerdictForExit(
  exit: number,
  engineVerdict?: string,
): 'pass' | 'warnings' | 'errors' | 'not-verified' | 'usage-error' {
  if (exit === ExitCode.VerifiedPass) return engineVerdict === 'warnings' ? 'warnings' : 'pass';
  if (exit === ExitCode.Failure) return 'errors';
  if (exit === ExitCode.NotVerified) return 'not-verified';
  return 'usage-error';
}
