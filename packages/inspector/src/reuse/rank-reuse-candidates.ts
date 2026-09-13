import {
  MatchConfidenceVerdict,
  ReuseCandidateSource,
  ReuseMatchSource,
  ReuseNameMatch,
  type IPublicExport,
  type IPublicExportSurface,
  type IReusePrimitive,
} from '@shrkcrft/core';
import type { IRankReuseOptions } from './rank-reuse-options.ts';
import { curatedReuseSuggestion, rankReuseSuggestions } from './rank-reuse-suggestions.ts';
import type { IReuseCandidate } from './reuse-candidate.ts';
import type { IReuseMatchDetail } from './reuse-match-detail.ts';
import type { IReuseRanking } from './reuse-ranking.ts';
import type { IReuseSuggestion } from './reuse-suggestion.ts';
import { isCuratedExport } from './resolve-curated-reuse.ts';
import { tokenizeReuseIntent } from './reuse-tokenize.ts';
import { reuseNameExtraTokens, reuseNameHits, scoreReuseName } from './score-reuse-name.ts';
import {
  isConfidentReuseMatch,
  reuseConfidenceFloor,
  scoreReusePrimitive,
} from './score-reuse-primitive.ts';

/** Declaration kinds that exist only at the type level. */
const TYPE_KINDS: ReadonlySet<string> = new Set(['interface', 'type-alias']);

/** A type-only export (interface / type alias) — excluded from reuse answers unless asked for. */
export function isReuseTypeKind(declKind: string): boolean {
  return TYPE_KINDS.has(declKind);
}

/** A test file never holds a construct to reuse. */
export function isReuseTestPath(path: string): boolean {
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || path.includes('/__tests__/') || path.startsWith('__tests__/')
  );
}

/** A NAME that answers the intent: every intent token is one of its name tokens (exact / covers). */
export function reuseNameAnswers(m: ReuseNameMatch): boolean {
  return m === ReuseNameMatch.Exact || m === ReuseNameMatch.Covers;
}

/**
 * THE curation-gap predicate. The lookup's `curationGap` and `shrk reuse
 * coverage`'s `shadowed` both call it, so the two agree by construction: an
 * uncurated export answers the intent by NAME (exact / covers) while the best
 * curated candidate names it only in part, or not at all (it matched through
 * its roles / keywords / description).
 */
export function isReuseCurationGap(
  bestCuratedNameMatch: ReuseNameMatch | undefined,
  uncuratedNameAnswers: number,
): boolean {
  return uncuratedNameAnswers > 0 && bestCuratedNameMatch !== undefined && !reuseNameAnswers(bestCuratedNameMatch);
}

/**
 * Intent → the construct to reuse, ranked over the curated `reusePrimitives[]`
 * AND (when a surface is given) the workspace's public export surface.
 *
 * Pure: the surface is INJECTED (the CLI reads it from the code graph), so the
 * engine stays callable from a read-only MCP tool and the inspector never
 * imports the graph.
 *
 * Tiers (lower wins; see `IReuseCandidate.tier`): curated whose NAME answers
 * the intent (exact / covers) → uncurated exact name → uncurated name covering
 * the intent → curated that names it only in part, or only through metadata.
 * Within a tier: score desc, then the closer name (fewer extra name tokens),
 * then symbol, then declaring file. An uncurated PARTIAL name match never
 * becomes an answer; it is offered as a did-you-mean only when nothing is.
 *
 * The export pool excludes constructs already curated (name AND declaring
 * file, see `curatedDeclaredIn`), names a curated entry `supersedes` (reported
 * in `superseded`), type-level kinds unless `includeTypes`, and test files.
 */
export function rankReuseCandidates(
  primitives: readonly IReusePrimitive[],
  surface: IPublicExportSurface | undefined,
  intent: string,
  opts: IRankReuseOptions = {},
): IReuseRanking {
  const tokens = tokenizeReuseIntent(intent);
  const count = tokens.length;
  const limit = Math.max(1, Math.floor(opts.limit ?? 3));
  const suggestLimit = Math.max(1, Math.floor(opts.suggestLimit ?? 5));
  const confidenceOf = (hits: number): number => (count === 0 ? 0 : hits / count);

  // ── curated ────────────────────────────────────────────────────────────
  const scored = primitives
    .map((p) => ({ p, d: scoreReusePrimitive(p, tokens) }))
    .filter((x) => x.d.score > 0)
    .sort((a, b) => b.d.score - a.d.score || a.p.symbol.localeCompare(b.p.symbol));
  const confidentCurated = scored.filter((x) => isConfidentReuseMatch(x.d, count));
  const curatedCandidate = (x: { p: IReusePrimitive; d: IReuseMatchDetail }, tier: number): IReuseCandidate => ({
    symbol: x.p.symbol,
    source: ReuseCandidateSource.Curated,
    tier,
    score: x.d.score,
    confidence: confidenceOf(x.d.matched.length),
    matched: x.d.matched,
    matchedVia: x.d.matchedVia,
    nameMatch: x.d.nameMatch,
    primitive: x.p,
  });
  // Tier 1 only when the curated NAME answers the intent. A curated entry that
  // shares one token of a three-token intent (`RangeSlider` for "date range
  // picker") must not outrank the exactly-named export: it ranks with the
  // metadata-only matches, below every uncurated exact / covering name.
  const tier1 = confidentCurated.filter((x) => reuseNameAnswers(x.d.nameMatch)).map((x) => curatedCandidate(x, 1));
  const tier4 = confidentCurated.filter((x) => !reuseNameAnswers(x.d.nameMatch)).map((x) => curatedCandidate(x, 4));

  // ── uncurated export surface ──────────────────────────────────────────
  const surfaceSearched = surface !== undefined && opts.curatedOnly !== true;
  const superseded: { symbol: string; package: string; supersededBy: string[] }[] = [];
  const exact: IReuseCandidate[] = [];
  const covers: IReuseCandidate[] = [];
  const partial: IReuseCandidate[] = [];
  if (surface !== undefined && surfaceSearched) {
    const curatedNames = new Set(primitives.map((p) => p.symbol));
    const supersededBy = new Map<string, string[]>();
    for (const p of primitives) {
      for (const name of p.supersedes ?? []) {
        const by = supersededBy.get(name);
        if (by) by.push(p.symbol);
        else supersededBy.set(name, [p.symbol]);
      }
    }
    const packageDir = new Map(surface.roots.map((r) => [r.package, r.dir]));
    const bySymbolId = new Map<string, IReuseCandidate>();
    for (const e of surface.exports) {
      if (isReuseTestPath(e.declaredIn)) continue;
      if (opts.includeTypes !== true && isReuseTypeKind(e.declKind)) continue;
      if (isCuratedExport(e, curatedNames, opts.curatedDeclaredIn)) continue;
      const nameMatch = scoreReuseName(e.name, tokens);
      if (nameMatch === ReuseNameMatch.None) continue;
      const by = supersededBy.get(e.name);
      if (by) {
        superseded.push({ symbol: e.name, package: e.package, supersededBy: by });
        continue;
      }
      const hits = reuseNameHits(e.name, tokens);
      const candidate: IReuseCandidate = {
        symbol: e.name,
        source: ReuseCandidateSource.ExportSurface,
        tier: nameMatch === ReuseNameMatch.Exact ? 2 : nameMatch === ReuseNameMatch.Covers ? 3 : 0,
        score: hits.length,
        confidence: confidenceOf(hits.length),
        matched: hits,
        matchedVia: [ReuseMatchSource.Symbol],
        nameMatch,
        export: e,
      };
      // One construct exposed by several packages (a sibling re-exports it):
      // keep the package that DECLARES it — that is the import to copy. The
      // surface is sorted by package, so without an owner the first one stays.
      const prev = bySymbolId.get(e.symbolId)?.export;
      const replaces =
        prev === undefined ||
        (declaresOwnExport(e, packageDir) && !declaresOwnExport(prev, packageDir));
      if (replaces) bySymbolId.set(e.symbolId, candidate);
    }
    for (const c of bySymbolId.values()) {
      if (c.nameMatch === ReuseNameMatch.Exact) exact.push(c);
      else if (c.nameMatch === ReuseNameMatch.Covers) covers.push(c);
      else partial.push(c);
    }
    const byUncurated = (a: IReuseCandidate, b: IReuseCandidate): number =>
      b.score - a.score ||
      reuseNameExtraTokens(a.symbol, tokens) - reuseNameExtraTokens(b.symbol, tokens) ||
      compare(a.symbol, b.symbol) ||
      compare(a.export?.declaredIn ?? '', b.export?.declaredIn ?? '') ||
      compare(a.export?.package ?? '', b.export?.package ?? '');
    exact.sort(byUncurated);
    covers.sort(byUncurated);
    partial.sort(byUncurated);
  }

  const results = [...tier1, ...exact, ...covers, ...tier4].slice(0, limit);
  const nameAnswered = tier1.length + exact.length + covers.length > 0;
  // The best curated candidate is tier 1's head when any curated NAME answers.
  const curationGap = isReuseCurationGap((tier1[0] ?? tier4[0])?.nameMatch, exact.length + covers.length);

  let verdict: MatchConfidenceVerdict;
  let suggestions: IReuseSuggestion[];
  if (results.length > 0) {
    verdict = MatchConfidenceVerdict.Confident;
    suggestions = [];
  } else {
    const weak: IReuseSuggestion[] = [
      ...scored.map((x) => curatedReuseSuggestion(x.p, x.d, count)),
      ...partial.map(uncuratedSuggestion),
    ];
    if (weak.length > 0) {
      verdict = MatchConfidenceVerdict.NoConfidentMatch;
      suggestions = weak.slice(0, suggestLimit);
    } else {
      verdict = MatchConfidenceVerdict.NoMatch;
      suggestions = rankReuseSuggestions(primitives, tokens, suggestLimit);
    }
  }
  const bestScore = Math.max(0, ...results.map((r) => r.score), ...suggestions.map((s) => s.score));

  return {
    tokens,
    confident: results.length > 0,
    verdict,
    floor: reuseConfidenceFloor(count),
    bestScore,
    results,
    suggestions,
    superseded,
    curationGap,
    nameAnswered,
    surfaceSearched,
  };
}

function uncuratedSuggestion(c: IReuseCandidate): IReuseSuggestion {
  return {
    symbol: c.symbol,
    score: c.score,
    confidence: c.confidence,
    matched: c.matched,
    roles: [],
    source: c.source,
    nameMatch: c.nameMatch,
    matchedVia: c.matchedVia,
    ...(c.export ? { package: c.export.package, declaredIn: c.export.declaredIn } : {}),
  };
}

/** Is `e` exposed by the package whose directory declares it? */
function declaresOwnExport(e: IPublicExport, packageDir: ReadonlyMap<string, string>): boolean {
  const dir = packageDir.get(e.package);
  return dir !== undefined && dir.length > 0 && (e.declaredIn === dir || e.declaredIn.startsWith(`${dir}/`));
}

/** Locale-independent ordering, so a ranking is byte-stable across machines. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
