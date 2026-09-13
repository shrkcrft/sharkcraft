import { ReuseMatchSource, type IReusePrimitive } from '@shrkcrft/core';
import type { IReuseMatchDetail } from './reuse-match-detail.ts';
import { scoreReuseName } from './score-reuse-name.ts';
import { tokenizeReuseIntent } from './reuse-tokenize.ts';

const SOURCE_ORDER: readonly ReuseMatchSource[] = [
  ReuseMatchSource.Symbol,
  ReuseMatchSource.Role,
  ReuseMatchSource.Keyword,
  ReuseMatchSource.Description,
];

/**
 * Score one curated primitive against the intent tokens, keeping WHICH field
 * each token hit — so a match through `keywords`/`description` alone is never
 * reported the same way as a match on the symbol's name.
 *
 * - symbol: token EQUALITY on the split name (`debounce` hits `useDebounce`;
 *   `ran` does not hit `DateRange`).
 * - roles / keywords / description: substring containment, as before. Moving
 *   those to token overlap belongs to the shared normaliser (round 11 §2.5), so
 *   reuse and the recommender switch together.
 *
 * The numeric score keeps its historical meaning: +1 per distinct intent token
 * that hit any field, +0.5 per role an intent token hit.
 */
export function scoreReusePrimitive(p: IReusePrimitive, tokens: readonly string[]): IReuseMatchDetail {
  const nameTokens = new Set(tokenizeReuseIntent(p.symbol));
  const roles = (p.roles ?? []).map((r) => r.toLowerCase());
  const keywords = (p.keywords ?? []).map((k) => k.toLowerCase());
  const description = (p.description ?? '').toLowerCase();
  const via = new Set<ReuseMatchSource>();
  const matched: string[] = [];
  let score = 0;
  for (const t of tokens) {
    let hit = false;
    if (nameTokens.has(t)) {
      via.add(ReuseMatchSource.Symbol);
      hit = true;
    }
    if (roles.some((r) => r.includes(t))) {
      via.add(ReuseMatchSource.Role);
      hit = true;
    }
    if (keywords.some((k) => k.includes(t))) {
      via.add(ReuseMatchSource.Keyword);
      hit = true;
    }
    if (description.includes(t)) {
      via.add(ReuseMatchSource.Description);
      hit = true;
    }
    if (hit) {
      score += 1;
      matched.push(t);
    }
  }
  // A role the intent mentions is a strong signal; re-weight role hits.
  for (const role of roles) {
    if (role.length >= 3 && tokens.some((t) => role.includes(t))) score += 0.5;
  }
  return {
    score,
    matched,
    symbolHit: via.has(ReuseMatchSource.Symbol),
    matchedVia: SOURCE_ORDER.filter((s) => via.has(s)),
    nameMatch: scoreReuseName(p.symbol, tokens),
  };
}

/**
 * Confidence floor: a keyword collision is not a match. A hit is only
 * "confident" when it matched the symbol NAME, OR matched ≥2 distinct intent
 * tokens, OR the intent was a single token and that token hit. A single
 * generic keyword hit on a multi-token intent is a weak match — surfaced as a
 * did-you-mean, never as a confident answer.
 */
export function isConfidentReuseMatch(detail: IReuseMatchDetail, queryTokenCount: number): boolean {
  if (detail.matched.length === 0) return false;
  if (detail.symbolHit) return true;
  if (detail.matched.length >= reuseConfidenceFloor(queryTokenCount)) return true;
  return false;
}

/**
 * The confidence floor, in distinct intent tokens a METADATA-only (non-name)
 * match must hit: 2, or 1 for a single-token intent. A name match always
 * clears it. This is the `floor` reuse reports in the shared confidence
 * vocabulary.
 */
export function reuseConfidenceFloor(queryTokenCount: number): number {
  return Math.max(1, Math.min(2, queryTokenCount));
}
