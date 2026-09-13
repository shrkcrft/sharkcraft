/**
 * Deterministic command recommender.
 *
 * Given an input ("what I want to do" or a stderr blob), recommend commands.
 * No AI, no embeddings. The report is a thin view over THE ranked list
 * (`rankRecommendationCandidates`): every row, `nextCommand`, the confidence
 * and its reasons come from that one list, so the CLI, MCP
 * `recommend_commands` and `shrk context` cannot disagree.
 */
import type { MatchConfidenceVerdict } from '@shrkcrft/core';
import type { IQueryIntentResult } from './query-intent-result.ts';
import type { IRankedRecommendations } from './ranked-recommendations.ts';
import type { IRecommendationCandidate } from './recommendation-candidate.ts';
import { rankRecommendationCandidates } from './recommendation-ranking.ts';
import type { RecommendationSource } from './recommendation-source.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { buildUncertaintyReport, type IUncertaintyReport } from './uncertainty-report.ts';

export const COMMAND_RECOMMENDER_SCHEMA = 'sharkcraft.command-recommender/v1';

export interface ICommandRecommendation {
  command: string;
  why: string;
  safetyLevel: 'read-only' | 'writes-drafts' | 'writes-session' | 'writes-source' | 'runs-shell';
  docsLink?: string;
  /** Which signal proposed the row (round 11). */
  source?: RecommendationSource;
  /** Hint id, recipe id, template/pipeline id, diagnostic code, plan verb or change-intent kind. */
  sourceId?: string;
  /** Normalised score: 1.0 = the source's own floor. */
  score?: number;
  /** Below the confidence floor — a guess, not a route. */
  weak?: boolean;
  /** One-line attribution, e.g. `routing hint "billing-refactor" (score 7, floor 3)`. */
  attribution?: string;
}

export interface ICommandRecommendationReport {
  schema: typeof COMMAND_RECOMMENDER_SCHEMA;
  generatedAt: string;
  query: string;
  role?: string;
  recommendations: readonly ICommandRecommendation[];
  nextCommand: string;
  warnings: readonly string[];
  /** Uncertainty report (confidence + reasons + safe fallback) — from THE confidence authority. */
  uncertainty: IUncertaintyReport;
  /** Shared confidence vocabulary: some candidate cleared the floor. An agent branches on this. */
  confident: boolean;
  verdict: MatchConfidenceVerdict;
  /** Floor multiplier in normalised units (1.0 = each source's own floor). */
  floor: number;
  /** Best eligible candidate's normalised score, confident or not. */
  bestScore: number;
  bestSource?: RecommendationSource;
  /** THE query-intent classification the eligibility gate used. */
  intent: IQueryIntentResult;
  /** The full ranked list, including suppressed rows (each with `suppressedReason`). */
  ranked: readonly IRecommendationCandidate[];
}

/** One report row from a ranked candidate. */
export function toCommandRecommendation(c: IRecommendationCandidate): ICommandRecommendation {
  return {
    command: c.command,
    why: c.why,
    safetyLevel: c.safetyLevel,
    ...(c.docsLink ? { docsLink: c.docsLink } : {}),
    source: c.source,
    ...(c.sourceId !== undefined ? { sourceId: c.sourceId } : {}),
    score: c.normalisedScore,
    weak: c.weak,
    attribution: c.attribution,
  };
}

/** The report for a ranked list — no re-ranking, no re-derivation. */
export function recommendationReportFromRanking(
  ranked: IRankedRecommendations,
  options: { role?: string } = {},
): ICommandRecommendationReport {
  const c = ranked.confidence;
  const recommendations = ranked.recommendations.map(toCommandRecommendation);
  const uncertainty = buildUncertaintyReport({
    confidence: c.level,
    reasons: c.reasons,
    missingSignals: c.missingSignals,
    conflictingSignals: c.conflictingSignals,
    suggestedCommands: recommendations.slice(0, 3).map((r) => r.command),
    safeFallbackCommand: 'shrk start-here',
    whatWouldIncreaseConfidence: c.whatWouldIncreaseConfidence,
  });
  return {
    schema: COMMAND_RECOMMENDER_SCHEMA,
    generatedAt: new Date().toISOString(),
    query: ranked.query,
    ...(options.role ? { role: options.role } : {}),
    recommendations,
    nextCommand: ranked.nextCommand,
    warnings: [...c.warnings],
    uncertainty,
    confident: c.confident,
    verdict: c.verdict,
    floor: c.floor,
    bestScore: c.bestScore,
    ...(c.bestSource ? { bestSource: c.bestSource } : {}),
    intent: ranked.intent,
    ranked: ranked.candidates,
  };
}

export async function recommendCommands(
  inspection: ISharkcraftInspection,
  query: string,
  options: { fromError?: string; role?: string; minScore?: number } = {},
): Promise<ICommandRecommendationReport> {
  const ranked = await rankRecommendationCandidates(inspection, query, {
    ...(options.fromError ? { fromError: options.fromError } : {}),
    ...(options.minScore !== undefined ? { minScore: options.minScore } : {}),
  });
  return recommendationReportFromRanking(ranked, options.role ? { role: options.role } : {});
}
