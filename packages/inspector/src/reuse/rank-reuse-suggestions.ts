import { ReuseCandidateSource, type IReusePrimitive } from '@shrkcrft/core';
import type { IReuseMatchDetail } from './reuse-match-detail.ts';
import type { IReuseSuggestion } from './reuse-suggestion.ts';
import { scoreReusePrimitive } from './score-reuse-primitive.ts';

/**
 * Rank ALL curated primitives by the matcher's own score (descending; ties
 * broken by symbol name so the order is deterministic), then return the top-`k`
 * as scored did-you-mean suggestions. Pure — no graph, no IO. When every
 * candidate scores 0 (a nonsense intent that shares no term) the result is the
 * alphabetically-first `k` primitives, each with `score: 0`; the caller states
 * "no candidate shares any term" in that case rather than dumping the catalog.
 */
export function rankReuseSuggestions(
  primitives: readonly IReusePrimitive[],
  tokens: readonly string[],
  k: number,
): IReuseSuggestion[] {
  const cap = Math.max(1, Math.floor(k));
  return primitives
    .map((p) => ({ p, detail: scoreReusePrimitive(p, tokens) }))
    .sort((a, b) => b.detail.score - a.detail.score || a.p.symbol.localeCompare(b.p.symbol))
    .slice(0, cap)
    .map(({ p, detail }) => curatedReuseSuggestion(p, detail, tokens.length));
}

/** One curated primitive as a suggestion row. */
export function curatedReuseSuggestion(
  p: IReusePrimitive,
  detail: IReuseMatchDetail,
  tokenCount: number,
): IReuseSuggestion {
  return {
    symbol: p.symbol,
    score: detail.score,
    confidence: tokenCount === 0 ? 0 : detail.matched.length / tokenCount,
    matched: detail.matched,
    roles: p.roles,
    source: ReuseCandidateSource.Curated,
    nameMatch: detail.nameMatch,
    matchedVia: detail.matchedVia,
  };
}
