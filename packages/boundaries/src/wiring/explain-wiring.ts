import {
  coverageAcceptance,
  coverageShortfall,
  normalizeWiringRule,
  settleRuleStatus,
  type IUnitLiveness,
  type IUnitStateLists,
  type IVerdictCoverage,
  type IWiringRule,
  type IWiringSource,
  type ScanZone,
} from '@shrkcrft/core';
import { sourceLivenessRequest } from '../extract/source-liveness-request.ts';
import { globListSelects } from '../scan/glob.ts';
import { globListUnits } from '../util/dead-glob-units.ts';
import { settleGlobLists } from '../util/settle-glob-lists.ts';
import { readMatchingFiles } from '../util/walk-files.ts';
import { unreadMatching } from '../util/read-scope-coverage.ts';
import {
  collectSourceSites,
  evaluateWiring,
  registeredSources,
  wiringGlobsOf,
  wiringSourceSide,
  type IWiringFileEntry,
  type IWiringHopResult,
  type IWiringReport,
  type IWiringTokenSite,
} from './evaluate-wiring.ts';
import { wiringLabeledSources } from './wiring-labeled-sources.ts';

export const WIRING_EXPLAIN_SCHEMA = 'sharkcraft.wiring-explain/v1' as const;

/** One side (declared or registered) of a wiring rule, as extracted from the tree. */
export interface IWiringSideExplain {
  /** Every capture site (token + file:line), stable-sorted by (file, line). */
  readonly sites: readonly IWiringTokenSite[];
  /** Distinct membership-key count (mirrors the gate's `declared/registered N`). */
  readonly distinctCount: number;
  /** Files scanned for this side (after glob resolution). */
  readonly filesScanned: number;
  /** Misconfiguration (bad regex / no capture group / bad source), if any. */
  readonly error?: string;
  /**
   * Named extractor this side resolved from, when it used one. Surfaced so an
   * author reading an explain can tell a SHARED selector from a local copy of
   * it — the two look identical in the extracted ids, and only one of them is
   * guaranteed to stay in step with the other planes.
   */
  readonly viaExtractor?: string;
  /** The lexical zone this side extracted from, when it is not the default `all`. */
  readonly scan?: ScanZone;
  /**
   * Characters a non-`all` `scan` blanked before extraction.
   *
   * A zone is the one setting that legitimately makes a rule match LESS while
   * still reading green, so the amount removed is shown rather than assumed: a
   * suspicious drop separates "the pattern was reading prose" from "the glob
   * went stale".
   */
  readonly blankedChars?: number;
}

/**
 * The full intermediate output of evaluating ONE wiring rule against the live
 * tree: the declared set and the registered set each source extracted (with
 * file:line), plus the set-difference and verdict — the thing {@link
 * evaluateWiring} computes internally but only emits as counts + violations.
 */
export interface IWiringExplain {
  readonly schema: typeof WIRING_EXPLAIN_SCHEMA;
  readonly ruleId: string;
  readonly description?: string;
  readonly mode: 'subset' | 'parity' | 'disjoint';
  readonly registeredMode: 'union' | 'intersection';
  readonly groupBy?: 'dir' | 'package';
  readonly severity: 'error' | 'warning';
  readonly declared: IWiringSideExplain;
  readonly registered: IWiringSideExplain;
  /** Declared tokens absent from the registered set (the `declared-missing` diff). */
  readonly declaredNotRegistered: readonly IWiringTokenSite[];
  /** Registered tokens absent from the declared set (parity-only `registered-missing`). */
  readonly registeredNotDeclared: readonly IWiringTokenSite[];
  /** Tokens present on BOTH sides (disjoint-only `overlap`). */
  readonly overlap: readonly IWiringTokenSite[];
  /** Per-hop breakdown when the rule is a multi-hop `chain`. */
  readonly hops?: readonly IWiringHopResult[];
  /**
   * `passed` / `partial` / `failed` / `skipped` / `error` — skipped is never a
   * pass, and neither is `partial`: a rule the engine reported `passed` whose
   * {@link coverage} has a shortfall. Derived by core's `settleRuleStatus`, the
   * same function the gate envelope uses, so `gates explain` and `gates check`
   * report the same status for the same rule.
   */
  readonly status: 'passed' | 'partial' | 'failed' | 'skipped' | 'error';
  /** Why the rule checked nothing, when it was skipped. */
  readonly skipReason?: string;
  /**
   * The engine's verdict, settled against {@link coverage}: a `pass` or
   * `warnings` verdict over a coverage shortfall is `not-verified` — exactly the
   * `0 → 2` the gate envelope applies. `errors` is never changed.
   */
  readonly verdict: 'pass' | 'errors' | 'warnings' | 'not-verified';
  /** What the rule examined against what it was asked to (the engine's own coverage). */
  readonly coverage: IVerdictCoverage;
  /** The coverage gap that vetoes a clean verdict, when there is one (`coverageShortfall`). */
  readonly shortfall?: string;
  /** A gap the rule's own config waived (`registeredExtras`), printed — never silent. */
  readonly acceptance?: string;
  /**
   * The rule's `expectEmpty` acceptance (round 13) — the engine's settle record
   * B, read off the rule result exactly as `check wiring` carries it — so a
   * verdict settled over this explain (`settleWiringExplain`, `gates try`)
   * folds it through `ruleVerdictRecords` and prints it. When the rule is
   * intended-empty it IS {@link coverage}.
   */
  readonly unitAcceptance?: IVerdictCoverage;
  /** The rule's dead / intended-empty / went-live glob units as printed lines. */
  readonly units?: IUnitStateLists;
  /**
   * The rule's non-live glob units as the engine settled them (round 13
   * review, additive) — what the explain renderers' went-live / dead block
   * reads, so explain says what `check wiring` and `gates coverage` say.
   */
  readonly unitLiveness?: readonly IUnitLiveness[];
  /** Rule-level misconfiguration messages (engine degrades gracefully). */
  readonly diagnostics: readonly string[];
}

export interface IExplainWiringOptions {
  /** Project-relative directories to prune from the walk. */
  readonly excludeDirs?: readonly string[];
}

/**
 * The zone the registered side extracted under — only when EVERY sink agrees on
 * a non-default one. Reporting one sink's zone as the side's would be a claim
 * the explain cannot back.
 */
function registeredScanZone(sources: readonly IWiringSource[]): ScanZone | undefined {
  if (sources.length === 0) return undefined;
  const first = sources[0]!.scan ?? 'all';
  if (first === 'all') return undefined;
  return sources.every((s) => (s.scan ?? 'all') === first) ? first : undefined;
}

function sortSites(sites: readonly IWiringTokenSite[]): IWiringTokenSite[] {
  return [...sites].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.token.localeCompare(b.token),
  );
}

/**
 * Dry-run a single wiring rule against the live tree and return what each side
 * extracted (declared set, registered set, the set-difference, the verdict) —
 * WITHOUT writing config. Powers `wiring explain <ruleId>`, `wiring test
 * <candidate>`, `gates explain <id>`, and `check wiring --explain <ruleId>`: the
 * author can SEE the cross-file set-difference the gate computes before
 * committing a rule. The diff/verdict reuse {@link evaluateWiring} so they match
 * the gate exactly (incl. `groupBy` membership). Never throws.
 */
/**
 * The extractor a rule's registered side resolved from — only when EVERY sink
 * shares it. A union of sinks where one is shared and another is inline has no
 * single answer, and naming just one would be a claim the config does not make.
 */
function registeredExtractorRef(rule: IWiringRule): string | undefined {
  const sinks = Array.isArray(rule.registered)
    ? (rule.registered as readonly IWiringSource[])
    : rule.registered
      ? [rule.registered as IWiringSource]
      : [];
  if (sinks.length === 0) return undefined;
  const first = sinks[0]!.$use;
  return first !== undefined && sinks.every((s) => s.$use === first) ? first : undefined;
}

export function explainWiring(
  projectRoot: string,
  authored: IWiringRule,
  options: IExplainWiringOptions = {},
): IWiringExplain {
  // The engine entry normalises idempotently (round 13): a loaded rule comes
  // back equal; a hand-built `{ pattern, expectEmpty }` entry (`wiring test`,
  // `gates try`) becomes a glob plus a marker. A MALFORMED entry is reported
  // the way the engine reports it — a misconfigured rule — and never reaches
  // a glob reader (it crashed `wiring test` with `glob.startsWith is not a
  // function`).
  const normalized = normalizeWiringRule(authored);
  if (!normalized.ok) return misconfiguredExplain(authored, evaluateWiring([authored], () => []));
  const rule = normalized.value;
  const excludeDirs = options.excludeDirs ?? [];
  const sourceSide = wiringSourceSide(rule);
  // For a chain, the reported "registered" side is the LAST hop (the far end).
  const sinkSources: readonly IWiringSource[] =
    rule.chain && rule.chain.length >= 2
      ? [rule.chain[rule.chain.length - 1]!]
      : registeredSources(rule.registered);

  const allGlobs = [...new Set(wiringGlobsOf(rule))];
  const matched = readMatchingFiles(projectRoot, allGlobs, new Set(options.excludeDirs ?? []));
  const entries: IWiringFileEntry[] = [...matched.files.entries()].map(([path, content]) => ({
    path,
    content,
  }));
  const filesFor = (source: IWiringSource): IWiringFileEntry[] =>
    entries.filter((f) => globListSelects(f.path, source.files ?? []));
  // The same unread list the check hands its engine, so the explain's coverage
  // (read off the engine, never recomputed) names the same unread files.
  const unreadFor = (source: IWiringSource): ReturnType<typeof unreadMatching> =>
    unreadMatching(matched.unread, source.files ?? []);

  const declaredFiles = sourceSide ? filesFor(sourceSide) : [];
  const declaredRes = sourceSide
    ? collectSourceSites(sourceSide, declaredFiles)
    : { sites: [] as readonly IWiringTokenSite[], error: 'rule sets no source side' };

  const registeredFiles = new Set<string>();
  const registeredSites: IWiringTokenSite[] = [];
  let registeredError: string | undefined;
  let registeredBlanked = 0;
  for (const source of sinkSources) {
    const files = filesFor(source);
    for (const f of files) registeredFiles.add(f.path);
    const res = collectSourceSites(source, files);
    if (res.error && !registeredError) registeredError = res.error;
    if (res.blankedChars !== undefined) registeredBlanked += res.blankedChars;
    registeredSites.push(...res.sites);
  }

  // Canonical diff + counts + verdict from the gate engine (same groupBy logic),
  // handed the SAME hooks `runWiring` gives it (round 13): which negations
  // emptied a source, and every source's glob units settled with their
  // `expectEmpty` markers (`sourceLivenessRequest` over the engine's side
  // labels). An explained rule is therefore accepted, skipped or failed exactly
  // as `check wiring` settles it — a planned rule the check accepts used to
  // explain as "SKIPPED … Verdict: errors" (`check wiring --explain` exit 1,
  // `gates try` 2).
  const walked = entries.map((f) => f.path);
  const unitsOf = (globs: readonly string[]): ReturnType<typeof globListUnits> =>
    globListUnits(walked, matched.unread, globs);
  const report = evaluateWiring(
    [rule],
    filesFor,
    {},
    unreadFor,
    (source) => {
      const units = unitsOf(source.files ?? []);
      return units.allExcluded ? units.negations : undefined;
    },
    (r) => settleGlobLists(sourceLivenessRequest(projectRoot, wiringLabeledSources(r), excludeDirs, r.id, unitsOf)),
  );
  const ruleResult = report.rules[0];
  const byDirection = (d: string): IWiringTokenSite[] =>
    sortSites(
      (ruleResult?.violations ?? [])
        .filter((v) => v.direction === d)
        .map((v) => ({ token: v.token, file: v.file, line: v.line })),
    );
  const skip = report.skipped[0];
  // The engine's coverage, read — never recomputed — and settled with the SAME
  // core functions the gate envelope uses: a `passed` rule with a shortfall is
  // `partial`, and a non-`errors` verdict over a shortfall is `not-verified`.
  const coverage: IVerdictCoverage = ruleResult?.coverage ?? {
    unit: 'declared tokens',
    expected: 0,
    examined: 0,
    reason: 'the rule did not run',
  };
  const shortfall = coverageShortfall(coverage);
  const acceptance = coverageAcceptance(coverage);

  return {
    schema: WIRING_EXPLAIN_SCHEMA,
    ruleId: rule.id,
    ...(rule.description ? { description: rule.description } : {}),
    mode: rule.mode ?? 'subset',
    registeredMode: rule.registeredMode ?? 'union',
    ...(rule.groupBy ? { groupBy: rule.groupBy } : {}),
    severity: rule.severity ?? 'error',
    declared: {
      sites: sortSites(declaredRes.sites),
      distinctCount: ruleResult?.declaredCount ?? 0,
      filesScanned: declaredFiles.length,
      ...(declaredRes.error ? { error: declaredRes.error } : {}),
      ...(rule.declared?.$use ? { viaExtractor: rule.declared.$use } : {}),
      ...(sourceSide?.scan && sourceSide.scan !== 'all'
        ? { scan: sourceSide.scan, blankedChars: declaredRes.blankedChars ?? 0 }
        : {}),
    },
    registered: {
      sites: sortSites(registeredSites),
      distinctCount: ruleResult?.registeredCount ?? 0,
      filesScanned: registeredFiles.size,
      ...(registeredError ? { error: registeredError } : {}),
      ...(registeredExtractorRef(rule) ? { viaExtractor: registeredExtractorRef(rule) } : {}),
      ...(registeredScanZone(sinkSources)
        ? { scan: registeredScanZone(sinkSources)!, blankedChars: registeredBlanked }
        : {}),
    },
    declaredNotRegistered: byDirection('declared-missing'),
    // Read, never recomputed: the engine's ONE registered-minus-declared set —
    // parity's violations and subset's coverage shortfall are the same set.
    registeredNotDeclared: sortSites(
      (ruleResult?.registeredOnly ?? []).map((s) => ({ token: s.token, file: s.file, line: s.line })),
    ),
    overlap: byDirection('overlap'),
    ...(ruleResult?.hops ? { hops: ruleResult.hops } : {}),
    status: settleRuleStatus(ruleResult?.status ?? 'error', coverage),
    ...(skip ? { skipReason: skip.reason } : {}),
    verdict: report.verdict !== 'errors' && shortfall !== undefined ? 'not-verified' : report.verdict,
    coverage,
    ...(shortfall !== undefined ? { shortfall } : {}),
    ...(acceptance !== undefined ? { acceptance } : {}),
    ...(ruleResult?.unitAcceptance !== undefined ? { unitAcceptance: ruleResult.unitAcceptance } : {}),
    ...(ruleResult?.units !== undefined ? { units: ruleResult.units } : {}),
    ...(ruleResult?.unitLiveness !== undefined ? { unitLiveness: ruleResult.unitLiveness } : {}),
    diagnostics: report.diagnostics,
  };
}

/**
 * The explain of a rule whose markable list is malformed (round 13): the
 * engine's own misconfigured result (`evaluateWiring` normalises at entry and
 * reports the bad entry), with empty sides — no glob reader ever sees it.
 */
function misconfiguredExplain(rule: IWiringRule, report: IWiringReport): IWiringExplain {
  const ruleResult = report.rules[0];
  const coverage: IVerdictCoverage = ruleResult?.coverage ?? {
    unit: 'declared tokens',
    expected: 0,
    examined: 0,
    reason: 'the rule did not run',
  };
  const shortfall = coverageShortfall(coverage);
  const error = report.diagnostics[0] ?? ruleResult?.error ?? 'the rule is misconfigured';
  return {
    schema: WIRING_EXPLAIN_SCHEMA,
    ruleId: rule.id,
    ...(rule.description ? { description: rule.description } : {}),
    mode: rule.mode ?? 'subset',
    registeredMode: rule.registeredMode ?? 'union',
    ...(rule.groupBy ? { groupBy: rule.groupBy } : {}),
    severity: rule.severity ?? 'error',
    declared: { sites: [], distinctCount: 0, filesScanned: 0, error },
    registered: { sites: [], distinctCount: 0, filesScanned: 0 },
    declaredNotRegistered: [],
    registeredNotDeclared: [],
    overlap: [],
    status: settleRuleStatus(ruleResult?.status ?? 'error', coverage),
    verdict: report.verdict !== 'errors' && shortfall !== undefined ? 'not-verified' : report.verdict,
    coverage,
    ...(shortfall !== undefined ? { shortfall } : {}),
    diagnostics: report.diagnostics,
  };
}
