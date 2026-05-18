import type { WorkspaceProfile } from '@shrkcrft/workspace';
import type { IPreset } from '../model/preset.ts';

export interface IPresetRecommendation {
  preset: IPreset;
  score: number;
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
}

export interface IRecommendOptions {
  profiles: readonly WorkspaceProfile[];
  /** Optional list of preset ids to exclude (e.g. already applied). */
  exclude?: readonly string[];
  /** Max number of recommendations. Default: 5. */
  limit?: number;
}

/**
 * Rank presets against detected workspace profiles. Pure function:
 *  - +5 for each profile in appliesTo that is present
 *  - −3 for each profile in appliesTo that is missing
 *    (so a preset that lists `[HasNext, HasReact, IsFrontend]` does
 *    not outrank `[HasReact, IsFrontend]` on a pure-React repo just
 *    because of its base weight). The penalty is intentionally
 *    smaller than the +5 match so a partial match still beats no
 *    match.
 *  - −5 per profile in notAppropriateFor that is present (drops the
 *    preset entirely)
 *  - +base weight (default 5) to break ties
 */
export function recommendPresets(
  presets: readonly IPreset[],
  options: IRecommendOptions,
): IPresetRecommendation[] {
  const profileSet = new Set(options.profiles);
  const exclude = new Set(options.exclude ?? []);
  const out: IPresetRecommendation[] = [];
  for (const preset of presets) {
    if (exclude.has(preset.id)) continue;
    const reasons: string[] = [];
    let score = preset.weight ?? 5;
    let dq = false;
    let matchedCount = 0;
    for (const need of preset.appliesTo ?? []) {
      if (profileSet.has(need)) {
        score += 5;
        matchedCount += 1;
        reasons.push(`matches profile: ${need}`);
      } else {
        // Small miss penalty so longer / more-specific appliesTo
        // lists do not falsely dominate shorter, more-targeted ones.
        score -= 3;
        reasons.push(`missing profile: ${need}`);
      }
    }
    for (const block of preset.notAppropriateFor ?? []) {
      if (profileSet.has(block)) {
        score -= 5;
        reasons.push(`not appropriate (profile: ${block})`);
        dq = true;
      }
    }
    if (dq) continue;
    if ((preset.appliesTo?.length ?? 0) === 0 && reasons.length === 0) {
      reasons.push('universal preset');
    }
    const confidence =
      score >= 15 ? 'high' : score >= 9 ? 'medium' : 'low';
    out.push({ preset, score, confidence, reasons });
    // matchedCount is reserved for future tie-breaking; surface in reasons
    // for now so the explanation captures it.
    void matchedCount;
  }
  out.sort((a, b) => b.score - a.score);
  const limit = options.limit ?? 5;
  return out.slice(0, limit);
}
