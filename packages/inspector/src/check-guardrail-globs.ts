/**
 * Guardrail-glob enforcement for the delegate worker.
 *
 * A recipe declares an ALLOW-LIST of globs (`guardrailGlobs`). A worker-emitted
 * target path that matches NONE of them is refused before any write — this is
 * one of the deterministic fences the model cannot influence, layered ON TOP of
 * the generator's `safeResolveTargetPath` floor.
 *
 * CRITICAL: the caller MUST pass the NORMALIZED relative path that will actually
 * be written (the output of `safeResolveTargetPath`), not the raw string a
 * worker emitted — otherwise a `../` traversal whose `**` the glob swallows
 * would pass the fence yet write elsewhere in-root. Matching here is
 * CASE-SENSITIVE (file paths are case-significant on the platforms that matter),
 * so `src/**` does not also grant `SRC/…`.
 *
 * Pure: deterministic glob match; no I/O, no model.
 */
import { globToRegex, toPosix } from './contract-file-rule.ts';

export interface IGuardrailGlobResult {
  /** Target paths covered by at least one guardrail glob. */
  allowed: readonly string[];
  /** Target paths covered by NO guardrail glob — these must not be written. */
  refused: readonly string[];
  /** True when every target path is allowed. */
  ok: boolean;
}

/**
 * Partition `targetPaths` into allowed / refused against the recipe's
 * `guardrailGlobs` (allow-list). An empty glob list refuses everything — a
 * recipe with no blast-radius fence must not write (the config validator also
 * rejects this, but the check is defensive here too).
 */
export function checkGuardrailGlobs(
  targetPaths: readonly string[],
  guardrailGlobs: readonly string[],
): IGuardrailGlobResult {
  const matchers = guardrailGlobs.map((g) => globToRegex(toPosix(g)));
  const allowed: string[] = [];
  const refused: string[] = [];
  for (const path of targetPaths) {
    const f = toPosix(path);
    const covered = matchers.some((re) => re.test(f));
    if (covered) allowed.push(path);
    else refused.push(path);
  }
  return { allowed, refused, ok: refused.length === 0 };
}
