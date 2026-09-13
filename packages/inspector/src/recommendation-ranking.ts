/**
 * THE recommendation ranking — one ranked list, owned by the inspector.
 *
 * The recommend headline used to be assembled by two promotion paths (the
 * inspector's ranker arbitration and the CLI's routing-hint "R1" block) with
 * three threshold pairs, a CLI-only grounding prepend, and a confidence
 * ladder keyed on WHICH code path fired. A routing hint could match at score
 * 7 and still be dropped for every non-create intent while the uncertainty
 * line said "No recipe matched", and MCP / `shrk context` never saw a hint's
 * commands at all.
 *
 * Now every signal source proposes candidates into one list:
 *   diagnostic (`--from-error`) · planning (grounding, pinned) · routing hint ·
 *   ranker template · ranker pipeline · built-in recipe · intent fallback.
 * Each candidate is normalised by ITS OWN floor (`RECOMMEND_SOURCE_FLOORS`),
 * so 1.0 means "just strong enough" whatever the source; the configured floor
 * is a multiplier on that. Eligibility is gated by THE query-intent classifier
 * (a source-writing scaffold is never recommended for non-create work) and by
 * distinct-term evidence (a ranker match on one incidental word is not a
 * match). Confidence (`deriveRecommendationConfidence`) is a function of the
 * same scores, and `nextCommand` is picked LAST from the final list.
 * Suppressed candidates stay in the list with their reason — never silent.
 */
import { MatchConfidenceVerdict } from '@shrkcrft/core';
import { ChangeIntentKind, classifyChangeIntent } from './change-intent.ts';
import { commandSafetyLevel } from './command-safety-level.ts';
import { buildDiagnosticByCode, listDiagnostics } from './failure-diagnostics.ts';
import { prepareTermQuery } from './match-terms.ts';
import { classifyQueryIntent, intentAdmitsSourceWrites } from './query-intent.ts';
import { QueryIntent } from './query-intent-kind.ts';
import type { IQueryIntentResult } from './query-intent-result.ts';
import type { IRankedRecommendations } from './ranked-recommendations.ts';
import { matchRecommendRecipe, RECOMMEND_RECIPES } from './recommend-recipes.ts';
import type { IRecommendationCandidate } from './recommendation-candidate.ts';
import type { IRecommendationConfidence } from './recommendation-confidence.ts';
import type { IRecommendationRankingOptions } from './recommendation-ranking-options.ts';
import { RecommendationSource } from './recommendation-source.ts';
import { RecommendationSuppression } from './recommendation-suppression.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { rankAll } from './task-ranker.ts';
import { explainTaskRouting, type ITaskRoutingMatchResult } from './task-routing-hint-registry.ts';
import type { IUncertaintySignalDetail } from './uncertainty-report.ts';

/**
 * Each source's own floor, in its own raw units — the ONE table that replaced
 * the inspector's 6/8 promote thresholds and the CLI's 3 (hint promote) and
 * 3/3 (engine match) thresholds.
 */
export const RECOMMEND_SOURCE_FLOORS: Readonly<Record<RecommendationSource, number>> = {
  [RecommendationSource.Diagnostic]: 1,
  [RecommendationSource.Planning]: 1,
  // explainTaskRouting: +2 per keyword, +3 per phrase, +2 per regex (+ boost) —
  // at least one phrase, or two keyword/regex hits.
  [RecommendationSource.RoutingHint]: 3,
  [RecommendationSource.RankerTemplate]: 6,
  // Higher than templates: a generic catch-all pipeline scores low on noise.
  [RecommendationSource.RankerPipeline]: 8,
  // 2 × distinct matched recipe terms/phrases.
  [RecommendationSource.Recipe]: 2,
  [RecommendationSource.IntentFallback]: 1,
};

/** Tie-break: project data beats the engine's built-ins. */
const SOURCE_PRECEDENCE: Readonly<Record<RecommendationSource, number>> = {
  [RecommendationSource.Diagnostic]: 0,
  [RecommendationSource.RoutingHint]: 1,
  [RecommendationSource.RankerTemplate]: 2,
  [RecommendationSource.RankerPipeline]: 3,
  [RecommendationSource.Recipe]: 4,
  [RecommendationSource.Planning]: 5,
  [RecommendationSource.IntentFallback]: 6,
};

/** Every intent-fallback row scores this (normalised): always below the default floor. */
const INTENT_FALLBACK_SCORE = 0.5;
/** A different-source runner-up at or above this share of the top makes the answer `medium`. */
const CLOSE_RUNNER_UP_RATIO = 0.75;
/** A ranker match must share at least this many DISTINCT content terms with the query. */
const MIN_RANKER_TERMS = 2;
const DEFAULT_FLOOR = 1;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmt(n: number): string {
  return n.toFixed(2);
}

/** Planning and the intent fallback never make an answer confident. */
export function countsTowardConfidence(source: RecommendationSource): boolean {
  return source !== RecommendationSource.Planning && source !== RecommendationSource.IntentFallback;
}

/** The floor multiplier: explicit (CLI `--min-score` / MCP `minScore`) > config `recommend.minScore` > 1. */
export function resolveRecommendFloor(inspection: ISharkcraftInspection, explicit?: number): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) return explicit;
  const configured = inspection.config?.recommend?.minScore;
  if (configured !== undefined && Number.isFinite(configured) && configured > 0) return configured;
  return DEFAULT_FLOOR;
}

function sourceLabel(source: RecommendationSource): string {
  switch (source) {
    case RecommendationSource.RoutingHint:
      return 'routing hint';
    case RecommendationSource.Recipe:
      return 'recipe';
    case RecommendationSource.RankerTemplate:
      return 'ranker template';
    case RecommendationSource.RankerPipeline:
      return 'ranker pipeline';
    case RecommendationSource.Diagnostic:
      return 'diagnostic';
    case RecommendationSource.Planning:
      return 'planning query';
    default:
      return 'intent fallback';
  }
}

/** THE one-line attribution of a candidate, e.g. `routing hint "billing-refactor" (score 7, floor 3)`. */
export function describeRecommendationSource(
  c: Pick<IRecommendationCandidate, 'source' | 'sourceId' | 'rawScore' | 'sourceFloor'>,
): string {
  const id = c.sourceId ?? '?';
  switch (c.source) {
    case RecommendationSource.Diagnostic:
      return `diagnostic "${id}"`;
    case RecommendationSource.Planning:
      return `planning query ("${id}")`;
    case RecommendationSource.IntentFallback:
      return `intent fallback (${id})`;
    default:
      return `${sourceLabel(c.source)} "${id}" (score ${round2(c.rawScore)}, floor ${c.sourceFloor})`;
  }
}

/** THE wording of why a candidate was kept out of the list. */
export function describeSuppression(c: IRecommendationCandidate, intent?: IQueryIntentResult): string {
  switch (c.suppressedReason) {
    case RecommendationSuppression.NonCreateIntent:
      return `writes source, and the query is not create/build work${
        intent?.vetoedBy ? ` ("${intent.vetoedBy}" makes it a repair/diagnosis)` : ''
      }`;
    case RecommendationSuppression.SingleIncidentalTerm:
      return `shares ${c.matchedTerms.length} distinct term(s) with the query — one incidental word is not evidence`;
    case RecommendationSuppression.BelowFloor:
      return c.weak ? 'writes source, below its floor' : 'writes source, withheld while nothing is confident';
    default:
      return '';
  }
}

/** The evidence sentence reasons are built from. */
function evidenceSentence(c: IRecommendationCandidate): string {
  const label = sourceLabel(c.source);
  const head = label.charAt(0).toUpperCase() + label.slice(1);
  const terms = c.matchedTerms.length > 0 ? `: ${c.matchedTerms.join(', ')}` : '';
  return `${head} "${c.sourceId ?? '?'}" matched (score ${round2(c.rawScore)}, floor ${c.sourceFloor}${terms}).`;
}

interface ICandidateInput {
  readonly command: string;
  readonly why: string;
  readonly source: RecommendationSource;
  readonly sourceId?: string;
  readonly rawScore: number;
  readonly matchedTerms?: readonly string[];
  readonly docsLink?: string;
  /** Fixed normalised score (intent fallback), instead of rawScore / floor. */
  readonly normalisedOverride?: number;
}

function makeCandidate(
  input: ICandidateInput,
  floor: number,
  safetyOf?: IRecommendationRankingOptions['safetyOf'],
): IRecommendationCandidate {
  const sourceFloor = RECOMMEND_SOURCE_FLOORS[input.source];
  const normalisedScore = round2(input.normalisedOverride ?? input.rawScore / sourceFloor);
  // The command's DECLARED safety (the CLI's catalog, injected) wins; the regex
  // is only the fallback for a surface with no catalog or an uncatalogued string.
  const declared = safetyOf?.(input.command);
  const safetyLevel = declared?.safetyLevel ?? commandSafetyLevel(input.command);
  return {
    command: input.command,
    why: input.why,
    safetyLevel,
    source: input.source,
    ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
    rawScore: input.rawScore,
    sourceFloor,
    normalisedScore,
    matchedTerms: input.matchedTerms ?? [],
    writesSource: declared?.writesSource ?? safetyLevel === 'writes-source',
    // A pinned planning row is a deterministic read-only first step, never a guess.
    weak: input.source === RecommendationSource.Planning ? false : normalisedScore < floor,
    attribution: describeRecommendationSource({
      source: input.source,
      ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
      rawScore: input.rawScore,
      sourceFloor,
    }),
    ...(input.docsLink ? { docsLink: input.docsLink } : {}),
  };
}

function withSuppression(
  c: IRecommendationCandidate,
  reason: RecommendationSuppression | undefined,
): IRecommendationCandidate {
  return reason === undefined ? c : { ...c, suppressedReason: reason };
}

/** Planning pinned first; then normalised score desc; then source precedence; then declaration order. */
function sortCandidates(rows: readonly IRecommendationCandidate[]): IRecommendationCandidate[] {
  return rows
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const pa = a.c.source === RecommendationSource.Planning ? 0 : 1;
      const pb = b.c.source === RecommendationSource.Planning ? 0 : 1;
      if (pa !== pb) return pa - pb;
      if (b.c.normalisedScore !== a.c.normalisedScore) return b.c.normalisedScore - a.c.normalisedScore;
      const sp = SOURCE_PRECEDENCE[a.c.source] - SOURCE_PRECEDENCE[b.c.source];
      if (sp !== 0) return sp;
      return a.i - b.i;
    })
    .map((x) => x.c);
}

/** Dedup by command, keeping the first (best) row; the kept row names every other source that proposed it. */
function dedupeByCommand(rows: readonly IRecommendationCandidate[]): IRecommendationCandidate[] {
  const out: IRecommendationCandidate[] = [];
  const index = new Map<string, number>();
  for (const c of rows) {
    const at = index.get(c.command);
    if (at === undefined) {
      index.set(c.command, out.length);
      out.push(c);
      continue;
    }
    const kept = out[at]!;
    if (kept.attribution === c.attribution || (kept.alsoProposedBy ?? []).includes(c.attribution)) continue;
    out[at] = {
      ...kept,
      alsoProposedBy: [...(kept.alsoProposedBy ?? []), c.attribution],
      why: `${kept.why} Also proposed by ${c.attribution}.`,
    };
  }
  return out;
}

/** THE predicate behind `confident`: an eligible counting candidate at or above the floor. */
function hasConfidentCandidate(rows: readonly IRecommendationCandidate[], floor: number): boolean {
  return rows.some((c) => !c.suppressedReason && countsTowardConfidence(c.source) && c.normalisedScore >= floor);
}

/**
 * THE confidence authority for recommend, MCP `recommend_commands` and
 * `shrk context` — a function of the ranked scores, never of which code path
 * produced a row:
 *   - no eligible counting candidate at or above the floor → `confident:
 *     false`; verdict `no-confident-match` (or `no-match` when no source
 *     produced anything), level `low` / `unknown`;
 *   - the top is the shared ranker and a built-in recipe also cleared its
 *     floor → `medium`, `conflict-recipe-vs-ranker` and a `review:` warning;
 *   - a different-command runner-up from another source within 25% of the
 *     top → `medium` with a conflicting signal;
 *   - otherwise `high`.
 */
export function deriveRecommendationConfidence(
  candidates: readonly IRecommendationCandidate[],
  floor: number,
): IRecommendationConfidence {
  const counting = sortCandidates(
    candidates.filter((c) => !c.suppressedReason && countsTowardConfidence(c.source)),
  );
  const evidence = candidates.filter((c) => countsTowardConfidence(c.source));
  const suppressed = candidates.filter((c) => c.suppressedReason !== undefined);
  const strong = counting.filter((c) => c.normalisedScore >= floor);
  const best = counting[0];
  const bestFields = best
    ? { bestSource: best.source, ...(best.sourceId !== undefined ? { bestSourceId: best.sourceId } : {}) }
    : {};
  const reasons: string[] = [];
  const missingSignals: IUncertaintySignalDetail[] = [];
  const conflictingSignals: IUncertaintySignalDetail[] = [];
  const increase: string[] = [];
  const warnings: string[] = [];
  const suppressedNote =
    suppressed.length > 0
      ? `${suppressed.length} candidate(s) suppressed — ${suppressed[0]!.command}: ${describeSuppression(suppressed[0]!)}.`
      : undefined;

  if (strong.length === 0) {
    const verdict = evidence.length === 0 ? MatchConfidenceVerdict.NoMatch : MatchConfidenceVerdict.NoConfidentMatch;
    if (best) {
      reasons.push(`No confident match: best ${fmt(best.normalisedScore)} of floor ${fmt(floor)} — ${best.attribution}.`);
    } else if (evidence.length > 0) {
      reasons.push(`No confident match: every matching candidate was suppressed (floor ${fmt(floor)}).`);
    } else {
      reasons.push('Nothing matched — no routing hint, recipe or ranker item shares a term with the query.');
    }
    if (suppressedNote) reasons.push(suppressedNote);
    missingSignals.push({
      id: 'no-confident-match',
      message: `No routing hint, recipe or ranker match cleared its floor (×${fmt(floor)}).`,
    });
    increase.push(
      'Add a routing hint (sharkcraft/task-routing-hints.ts) whose keywords or phrases name this task class — its commands then headline.',
    );
    if (floor > DEFAULT_FLOOR) increase.push(`Lower recommend.minScore / --min-score (currently ${fmt(floor)}).`);
    return {
      confident: false,
      verdict,
      floor,
      bestScore: best?.normalisedScore ?? 0,
      ...bestFields,
      level: verdict === MatchConfidenceVerdict.NoMatch ? 'unknown' : 'low',
      reasons,
      missingSignals,
      conflictingSignals,
      whatWouldIncreaseConfidence: increase,
      warnings,
    };
  }

  const top = strong[0]!;
  const seen = new Set<string>();
  for (const c of strong) {
    const key = `${c.source}:${c.sourceId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reasons.push(evidenceSentence(c));
    if (seen.size >= 5) break;
  }
  if (suppressedNote) reasons.push(suppressedNote);

  let level: IRecommendationConfidence['level'] = 'high';
  const rankerTop = top.source === RecommendationSource.RankerTemplate || top.source === RecommendationSource.RankerPipeline;
  const recipeStrong = strong.find((c) => c.source === RecommendationSource.Recipe);
  const runnerUp = counting.find((c) => c.command !== top.command && c.source !== top.source);
  if (rankerTop && recipeStrong) {
    level = 'medium';
    const kind = top.source === RecommendationSource.RankerTemplate ? 'template' : 'pipeline';
    reasons.push(
      `Keyword recipe "${recipeStrong.sourceId}" matched, but the shared ranker's ${kind} "${top.sourceId}" scored higher (${fmt(top.normalisedScore)} vs ${fmt(recipeStrong.normalisedScore)}) and headlines — review which fits.`,
    );
    conflictingSignals.push({
      id: 'conflict-recipe-vs-ranker',
      message: `Recipe "${recipeStrong.sourceId}" competes with ranker ${kind} "${top.sourceId}". The headline was routed to the ranker match; confirm the intended target.`,
    });
    increase.push('Add a routing hint so the task routes to your project playbook instead of a keyword recipe.');
    warnings.push(
      `review: recipe keyword overlap was outranked by ranker ${kind} "${top.sourceId}" — headline routed to the ${kind === 'template' ? 'scaffold' : 'task packet'}; confirm before applying.`,
    );
  } else if (runnerUp && runnerUp.normalisedScore >= top.normalisedScore * CLOSE_RUNNER_UP_RATIO) {
    level = 'medium';
    conflictingSignals.push({
      id: `conflict-${top.source}-vs-${runnerUp.source}`,
      message: `${top.attribution} (${fmt(top.normalisedScore)}) and ${runnerUp.attribution} (${fmt(runnerUp.normalisedScore)}) are within 25% — confirm the intended target.`,
    });
    increase.push('Tighten the weaker signal (or strengthen the right one) so one route clearly leads.');
  }
  return {
    confident: true,
    verdict: MatchConfidenceVerdict.Confident,
    floor,
    bestScore: top.normalisedScore,
    ...bestFields,
    level,
    reasons,
    missingSignals,
    conflictingSignals,
    whatWouldIncreaseConfidence: increase,
    warnings,
  };
}

/**
 * THE "what do I run first?" pick, over the FINAL rendered rows (the CLI calls
 * it again after surface gating): when confident, the first non-weak row;
 * otherwise the read-only planning / intent-fallback row, else
 * `shrk start-here` — never a writes-source guess.
 */
export function pickNextCommand(
  rows: readonly {
    readonly command: string;
    readonly weak?: boolean;
    readonly safetyLevel: string;
    readonly source?: string;
  }[],
  confident: boolean,
): string {
  if (confident) {
    const first = rows.find((r) => r.weak !== true && r.safetyLevel !== undefined);
    if (first) return first.command;
  }
  const fallback = rows.find(
    (r) =>
      (r.source === RecommendationSource.Planning || r.source === RecommendationSource.IntentFallback) &&
      r.safetyLevel === 'read-only',
  );
  return fallback?.command ?? 'shrk start-here';
}

/** Build THE ranked recommendation list for a query. See the module comment. */
export async function rankRecommendationCandidates(
  inspection: ISharkcraftInspection,
  query: string,
  opts: IRecommendationRankingOptions = {},
): Promise<IRankedRecommendations> {
  const trimmed = query.trim();
  const floor = resolveRecommendFloor(inspection, opts.minScore);
  const scaffoldGate =
    opts.scaffoldRequiresCreateIntent ?? inspection.config?.recommend?.scaffoldRequiresCreateIntent ?? true;
  const intent = classifyQueryIntent(trimmed);
  const quoted = trimmed.replace(/"/g, '\\"');
  const drafts: IRecommendationCandidate[] = [];
  const push = (input: ICandidateInput): void => {
    drafts.push(makeCandidate(input, floor, opts.safetyOf));
  };

  // 1. Diagnostics — a stderr blob matching a known failure.
  if (opts.fromError && opts.fromError.length > 0) {
    const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const e of listDiagnostics()) {
      const built = buildDiagnosticByCode(e.code, {});
      const problem = built.problem.slice(0, 20);
      const hit =
        new RegExp(escape(e.code), 'i').test(opts.fromError) ||
        (problem.length > 0 && new RegExp(escape(problem), 'i').test(opts.fromError));
      if (!hit) continue;
      push({
        command: built.nextCommand,
        why: `Diagnostic match: ${e.code}.`,
        source: RecommendationSource.Diagnostic,
        sourceId: e.code,
        rawScore: 1,
        ...(built.docsLink ? { docsLink: built.docsLink } : {}),
      });
    }
  }

  // 2. Planning — grounding is the first step of a planning thread (DX#2, moved from the CLI).
  if (trimmed.length > 0 && intent.intent === QueryIntent.Plan) {
    push({
      command: `shrk grounding "${quoted}" --json`,
      why: `The query reads as planning ("${intent.planVerb ?? 'plan'}") — start with grounding (task-relevant rules / knowledge / templates / verification ids) before picking a write verb.`,
      source: RecommendationSource.Planning,
      sourceId: intent.planVerb ?? 'plan',
      rawScore: 1,
    });
  }

  // 3. Routing hints — one row per recommends.commands entry, in declared order.
  let routingMatches: readonly ITaskRoutingMatchResult[] = [];
  if (trimmed.length > 0) {
    try {
      routingMatches = await explainTaskRouting(inspection, trimmed);
    } catch {
      routingMatches = [];
    }
  }
  const hintFloor = RECOMMEND_SOURCE_FLOORS[RecommendationSource.RoutingHint];
  for (const m of routingMatches) {
    const evidence = m.reasons.map((r) => r.replace(/^(keyword|phrase|regex): /, '$1 '));
    for (const command of m.hint.recommends?.commands ?? []) {
      if (typeof command !== 'string' || command.trim().length === 0) continue;
      push({
        command,
        why: `Routing hint "${m.hint.id}" matched (score ${m.score}, floor ${hintFloor}: ${evidence.join(', ')}).`,
        source: RecommendationSource.RoutingHint,
        sourceId: m.hint.id,
        rawScore: m.score,
        matchedTerms: evidence,
      });
    }
  }

  // 4. Built-in recipes — THE term matcher, 2 points per distinct matched term.
  if (trimmed.length > 0) {
    const termQuery = prepareTermQuery(trimmed);
    for (const recipe of RECOMMEND_RECIPES) {
      const matched = matchRecommendRecipe(recipe, termQuery, trimmed);
      if (matched.length === 0) continue;
      for (const rec of recipe.recommendations) {
        push({
          command: rec.command,
          why: rec.why,
          source: RecommendationSource.Recipe,
          sourceId: recipe.id,
          rawScore: 2 * matched.length,
          matchedTerms: matched,
        });
      }
    }
  }

  // 5. The shared ranker (the one `brief` / `task` use) — its top template and pipeline.
  let rankerTop: IRankedRecommendations['rankerTop'] = null;
  if (trimmed.length > 0) {
    try {
      const ranking = rankAll(inspection, trimmed);
      const t = ranking.templates[0];
      const p = ranking.pipelines[0];
      rankerTop = {
        topTemplate: t ? { id: t.item.id, score: t.score } : null,
        topPipeline: p ? { id: p.item.id, score: p.score } : null,
      };
      if (t) {
        const terms = t.matchedTerms ?? [];
        push({
          command: `shrk gen ${t.item.id} <name> --dry-run`,
          why: `Ranker matched template "${t.item.name}" (score ${t.score}, floor ${RECOMMEND_SOURCE_FLOORS[RecommendationSource.RankerTemplate]}; terms: ${terms.join(', ') || 'none'}) — the project scaffold for this create/build task.`,
          source: RecommendationSource.RankerTemplate,
          sourceId: t.item.id,
          rawScore: t.score,
          matchedTerms: terms,
        });
      }
      if (p) {
        const terms = p.matchedTerms ?? [];
        push({
          command: `shrk task "${quoted}"`,
          why: `Ranker matched pipeline "${p.item.title}" (score ${p.score}, floor ${RECOMMEND_SOURCE_FLOORS[RecommendationSource.RankerPipeline]}; terms: ${terms.join(', ') || 'none'}) — run the full task packet for this task.`,
          source: RecommendationSource.RankerPipeline,
          sourceId: p.item.id,
          rawScore: p.score,
          matchedTerms: terms,
        });
      }
    } catch {
      // The ranker is advisory — the other sources still answer.
      rankerTop = null;
    }
  }

  // 6. Eligibility: THE intent classifier gates source-writing rows; a ranker
  //    match needs distinct-term evidence.
  const gate = (c: IRecommendationCandidate): RecommendationSuppression | undefined => {
    if (c.writesSource && scaffoldGate && !intentAdmitsSourceWrites(intent)) {
      return RecommendationSuppression.NonCreateIntent;
    }
    if (
      (c.source === RecommendationSource.RankerTemplate || c.source === RecommendationSource.RankerPipeline) &&
      c.matchedTerms.length < MIN_RANKER_TERMS
    ) {
      return RecommendationSuppression.SingleIncidentalTerm;
    }
    return undefined;
  };
  let candidates = drafts.map((c) => withSuppression(c, gate(c)));

  // 7. Intent fallback — only when nothing counting cleared the floor; always below it.
  if (!hasConfidentCandidate(candidates, floor)) {
    const change = await classifyChangeIntent(trimmed, inspection);
    const fallback = (command: string, why: string): IRecommendationCandidate => {
      const c = makeCandidate(
        {
          command,
          why,
          source: RecommendationSource.IntentFallback,
          sourceId: change.kind,
          rawScore: INTENT_FALLBACK_SCORE,
          normalisedOverride: INTENT_FALLBACK_SCORE,
        },
        floor,
        opts.safetyOf,
      );
      return withSuppression(c, gate(c));
    };
    candidates.push(fallback(change.suggestedFirstCommand, `Intent fallback (${change.kind}).`));
    if (change.kind === ChangeIntentKind.Unknown) {
      candidates.push(fallback('shrk start-here', 'No clear intent — start here.'));
    }
  }

  // 8. A source-writing action never holds a slot at low confidence.
  const confident = hasConfidentCandidate(candidates, floor);
  candidates = candidates.map((c) =>
    !c.suppressedReason && c.writesSource && (!confident || c.weak)
      ? withSuppression(c, RecommendationSuppression.BelowFloor)
      : c,
  );

  // 9. Rank, dedup, then confidence and nextCommand from the final list.
  const ordered = sortCandidates(candidates);
  const recommendations = dedupeByCommand(ordered.filter((c) => !c.suppressedReason));
  const suppressed = ordered.filter((c) => c.suppressedReason !== undefined);
  const all = [...recommendations, ...suppressed];
  const confidence = deriveRecommendationConfidence(all, floor);
  return {
    query: trimmed,
    intent,
    floor,
    candidates: all,
    recommendations,
    confidence,
    nextCommand: pickNextCommand(recommendations, confidence.confident),
    routingMatches,
    rankerTop,
  };
}
