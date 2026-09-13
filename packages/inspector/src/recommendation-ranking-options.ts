import type { ICommandSafety } from './i-command-safety.ts';

/** Options for `rankRecommendationCandidates`. */
export interface IRecommendationRankingOptions {
  /** A stderr blob: diagnostics matching it become candidates. */
  readonly fromError?: string;
  /**
   * Floor multiplier (> 0), in normalised units: 1.0 = each source's own
   * floor. Beats config `recommend.minScore`; defaults to 1.
   */
  readonly minScore?: number;
  /** Override config `recommend.scaffoldRequiresCreateIntent` (default true). */
  readonly scaffoldRequiresCreateIntent?: boolean;
  /**
   * THE declared safety of a command — injected by the CLI from its command
   * catalog (the inspector cannot import it), exactly as the command resolver
   * is injected into the reference registry. Wins over the `commandSafetyLevel`
   * regex, which stays only the fallback (`undefined` = uncatalogued). Round 11
   * review: the regex alone called `generated update`, `baseline update`,
   * `check wiring --fix` and 12 other catalog writers read-only, so the
   * not-confident withhold gate never withheld them.
   */
  readonly safetyOf?: (command: string) => ICommandSafety | undefined;
}
