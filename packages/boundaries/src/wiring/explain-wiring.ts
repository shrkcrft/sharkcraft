import type { IWiringRule, IWiringSource } from '@shrkcrft/core';
import { matchesAny } from '../scan/glob.ts';
import { readMatchingFiles } from '../util/walk-files.ts';
import {
  collectSourceSites,
  evaluateWiring,
  registeredSources,
  wiringGlobsOf,
  wiringSourceSide,
  type IWiringFileEntry,
  type IWiringHopResult,
  type IWiringTokenSite,
} from './evaluate-wiring.ts';

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
  /** `passed` / `failed` / `skipped` / `error` — skipped is never a pass. */
  readonly status: 'passed' | 'failed' | 'skipped' | 'error';
  /** Why the rule checked nothing, when it was skipped. */
  readonly skipReason?: string;
  readonly verdict: 'pass' | 'errors' | 'warnings';
  /** Rule-level misconfiguration messages (engine degrades gracefully). */
  readonly diagnostics: readonly string[];
}

export interface IExplainWiringOptions {
  /** Project-relative directories to prune from the walk. */
  readonly excludeDirs?: readonly string[];
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
  rule: IWiringRule,
  options: IExplainWiringOptions = {},
): IWiringExplain {
  const sourceSide = wiringSourceSide(rule);
  // For a chain, the reported "registered" side is the LAST hop (the far end).
  const sinkSources: readonly IWiringSource[] =
    rule.chain && rule.chain.length >= 2
      ? [rule.chain[rule.chain.length - 1]!]
      : registeredSources(rule.registered);

  const allGlobs = [...new Set(wiringGlobsOf(rule))];
  const cache = readMatchingFiles(projectRoot, allGlobs, new Set(options.excludeDirs ?? []));
  const entries: IWiringFileEntry[] = [...cache.entries()].map(([path, content]) => ({
    path,
    content,
  }));
  const filesFor = (source: IWiringSource): IWiringFileEntry[] =>
    entries.filter((f) => matchesAny(f.path, source.files ?? []));

  const declaredFiles = sourceSide ? filesFor(sourceSide) : [];
  const declaredRes = sourceSide
    ? collectSourceSites(sourceSide, declaredFiles)
    : { sites: [] as readonly IWiringTokenSite[], error: 'rule sets no source side' };

  const registeredFiles = new Set<string>();
  const registeredSites: IWiringTokenSite[] = [];
  let registeredError: string | undefined;
  for (const source of sinkSources) {
    const files = filesFor(source);
    for (const f of files) registeredFiles.add(f.path);
    const res = collectSourceSites(source, files);
    if (res.error && !registeredError) registeredError = res.error;
    registeredSites.push(...res.sites);
  }

  // Canonical diff + counts + verdict from the gate engine (same groupBy logic).
  const report = evaluateWiring([rule], filesFor);
  const ruleResult = report.rules[0];
  const byDirection = (d: string): IWiringTokenSite[] =>
    sortSites(
      (ruleResult?.violations ?? [])
        .filter((v) => v.direction === d)
        .map((v) => ({ token: v.token, file: v.file, line: v.line })),
    );
  const skip = report.skipped[0];

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
    },
    registered: {
      sites: sortSites(registeredSites),
      distinctCount: ruleResult?.registeredCount ?? 0,
      filesScanned: registeredFiles.size,
      ...(registeredError ? { error: registeredError } : {}),
      ...(registeredExtractorRef(rule) ? { viaExtractor: registeredExtractorRef(rule) } : {}),
    },
    declaredNotRegistered: byDirection('declared-missing'),
    registeredNotDeclared: byDirection('registered-missing'),
    overlap: byDirection('overlap'),
    ...(ruleResult?.hops ? { hops: ruleResult.hops } : {}),
    status: ruleResult?.status ?? 'error',
    ...(skip ? { skipReason: skip.reason } : {}),
    verdict: report.verdict,
    diagnostics: report.diagnostics,
  };
}
