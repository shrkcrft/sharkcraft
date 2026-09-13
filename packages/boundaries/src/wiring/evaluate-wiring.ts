import {
  failsWhenEmpty,
  normalizeWiringRule,
  RuleEmptiness,
  settleRuleEmptiness,
  unitStateLists,
  UnitLivenessState,
  validateWiringSource,
  type ISettledUnitLiveness,
  type IUnitLiveness,
  type IUnitStateLists,
  type IVerdictCoverage,
  type IWiringRule,
  type IWiringSource,
} from '@shrkcrft/core';
import { settleGlobLists } from '../util/settle-glob-lists.ts';
import {
  extractTokens,
  type IExtractContext,
  type IExtractFileEntry,
  type IExtractedSite,
} from '../extract/extract-tokens.ts';
import {
  describeUnread,
  mergeReadScopes,
  readScopeCoverage,
  readScopeHasUnread,
} from '../util/read-scope-coverage.ts';
import type { IUnreadFile } from '../util/unread-file.ts';
import type { IGlobNegation } from '../util/i-glob-negation.ts';
import { emptiedByNegationsReason } from '../util/negation-cause.ts';

export const WIRING_SCHEMA = 'sharkcraft.wiring/v1' as const;

/** A file made available to the engine. */
export type IWiringFileEntry = IExtractFileEntry;

/** A captured token + where it was captured. */
export type IWiringTokenSite = IExtractedSite;

/**
 * Per-rule outcome. `skipped` is deliberately DISTINCT from `passed`: a rule
 * whose source side extracted nothing checked nothing, and reporting that as a
 * pass is the single failure mode that lets a stale selector ship a real
 * violation. See {@link IWiringSkip}.
 */
export type WiringRuleStatus = 'passed' | 'failed' | 'skipped' | 'error';

export interface IWiringViolation {
  readonly ruleId: string;
  /** The token that is missing from (or wrongly shared with) the other side. */
  readonly token: string;
  /** Declaring (or registering) file (project-relative) + 1-based line. */
  readonly file: string;
  readonly line: number;
  readonly severity: 'error' | 'warning';
  /**
   * Which side the token is missing from. `declared-missing` (the subset case):
   * declared but not registered. `registered-missing` (parity only): registered
   * but never declared. `overlap` (disjoint only): present on both sides.
   */
  readonly direction?: 'declared-missing' | 'registered-missing' | 'overlap';
  /** For a `chain` rule: which hop pair failed (0-based). */
  readonly hop?: number;
  /** Rendered `message` template, when the rule sets one. */
  readonly message?: string;
  readonly hint?: string;
}

/** A rule that could not be evaluated because its source side matched nothing. */
export interface IWiringSkip {
  readonly ruleId: string;
  /** Human-readable cause (`0 files matched` / `0 ids extracted`). */
  readonly reason: string;
  /** True when the rule set `failOnEmpty` — the skip counts as a failure. */
  readonly failed: boolean;
  readonly severity: 'error' | 'warning';
}

/** One `hop_i ⊆ hop_i+1` step of a multi-hop chain rule. */
export interface IWiringHopResult {
  readonly index: number;
  readonly fromCount: number;
  readonly toCount: number;
  readonly missing: number;
}

export interface IWiringRuleResult {
  readonly ruleId: string;
  readonly description?: string;
  readonly severity: 'error' | 'warning';
  readonly status: WiringRuleStatus;
  readonly declaredCount: number;
  readonly registeredCount: number;
  /** Files actually scanned per side (after glob resolution) — the stale-glob signal. */
  readonly declaredFiles: number;
  readonly registeredFiles: number;
  readonly violations: readonly IWiringViolation[];
  /** Set when the rule is misconfigured (bad regex / no capture group / bad source). */
  readonly error?: string;
  /**
   * True when the SINK extracted 0 ids while the source extracted some. Every
   * declared token then "fails", which is a real failure — but almost always
   * because the sink glob went stale, so the diff is annotated rather than
   * silently reported as N unrelated violations.
   */
  readonly emptySink?: boolean;
  /**
   * A diagnosis for a side that extracted nothing for a knowable reason — e.g.
   * an `import-edges` sink targeting `to.files` against barrel imports. Carried
   * so the empty-sink message can explain itself instead of sending the reader
   * to check a glob that is fine.
   */
  readonly sinkHint?: string;
  /** Per-hop breakdown for a `chain` rule. */
  readonly hops?: readonly IWiringHopResult[];
  /**
   * Registered sites whose membership key the declared side never produced —
   * ONE derivation, two renderings. `parity` reports each as a
   * `registered-missing` violation; `subset` (the default) reports them here,
   * because a `declared ⊆ registered` rule never examined them: the declared
   * selector may be narrower than reality, and the rule would pass by
   * construction. Set for a classic (non-chain) subset/parity rule that ran,
   * sorted by membership key. `explainWiring` reads this rather than
   * recomputing it.
   */
  readonly registeredOnly?: readonly IWiringTokenSite[];
  /**
   * What the rule examined against what it was asked to (see
   * `IVerdictCoverage`). A subset rule whose registered side holds tokens the
   * declared selector never produced reports them as unexamined `registered
   * tokens`, so the gate envelope marks it `partial` and the verdict is not
   * verified — unless the rule's `registeredExtras` accepts them explicitly.
   * The engine fills it in; it never decides a verdict from it.
   */
  readonly coverage: IVerdictCoverage;
  /**
   * Glob-matched files on any side of the rule that the one reader did not
   * read (over the read cap, or unreadable). Set only when non-empty.
   * `coverage` names them too: such a rule is never a pass.
   */
  readonly unread?: readonly IUnreadFile[];
  /**
   * The acceptance of the rule's `expectEmpty` units — settle record B of
   * every source's glob lists (round 13). Folded into the envelope's ONE
   * settle beside {@link coverage}; when the rule is intended-empty it IS
   * {@link coverage}.
   */
  readonly unitAcceptance?: IVerdictCoverage;
  /** The rule's dead / intended-empty / went-live glob units as printed lines (`unitStateLists`). */
  readonly units?: IUnitStateLists;
  /** The rule's non-live glob units, for `--fail-on-dead-units` (`selectorUnitFails`). */
  readonly unitLiveness?: readonly IUnitLiveness[];
}

export interface IWiringReport {
  readonly schema: typeof WIRING_SCHEMA;
  readonly rules: readonly IWiringRuleResult[];
  readonly violations: readonly IWiringViolation[];
  /** Rule-level misconfiguration messages (never throws — degrades gracefully). */
  readonly diagnostics: readonly string[];
  /** Rules that checked nothing, reported loudly instead of as a green pass. */
  readonly skipped: readonly IWiringSkip[];
  /**
   * Count of rules that settled a verdict: ran a comparison, or were
   * misconfigured (counted so their error is not swallowed), or were ACCEPTED
   * as intended-empty (round 13 — every source inclusion glob marked
   * `expectEmpty`, 0 files matched; counted so the verdict path's
   * `evaluated === 0` NOT-VERIFIED guard never reads an accepted plan as
   * "nothing ran"). A rule whose source side matched 0 files or extracted 0 ids
   * WITHOUT that acceptance is NOT evaluated (see {@link skipped}). The printed
   * "N evaluated" excludes the accepted ones: N = `evaluated − acceptedEmpty`.
   */
  readonly evaluated: number;
  /**
   * Rules accepted as intended-empty (round 13, K6): they examined 0 files, so
   * a renderer prints them apart — `N evaluated, M accepted as
   * intended-empty` — never inside the evaluated count.
   */
  readonly acceptedEmpty: number;
  readonly verdict: 'pass' | 'errors' | 'warnings';
}

/** Resolves a rule-side's globs to the concrete files (path + content) to scan. */
export type WiringFileResolver = (source: IWiringSource) => readonly IWiringFileEntry[];

/** Normalize the `registered` field (single source or union array) to an array. */
export function registeredSources(reg: IWiringRule['registered']): readonly IWiringSource[] {
  if (reg === undefined) return [];
  return Array.isArray(reg) ? (reg as readonly IWiringSource[]) : [reg as IWiringSource];
}

/**
 * The rule's SOURCE side — the set whose membership is being asserted. For a
 * chain rule that is hop 0. Used for glob collection, the loud-skip test, and
 * `selfTest` expectations.
 */
export function wiringSourceSide(rule: IWiringRule): IWiringSource | undefined {
  if (rule.chain && rule.chain.length > 0) return rule.chain[0];
  return rule.declared;
}

/** Every source a rule references, in declaration order. */
export function wiringSourcesOf(rule: IWiringRule): readonly IWiringSource[] {
  if (rule.chain && rule.chain.length > 0) return rule.chain;
  const out: IWiringSource[] = [];
  if (rule.declared) out.push(rule.declared);
  out.push(...registeredSources(rule.registered));
  return out;
}

/** Every glob a rule references (both sides / every hop). */
export function wiringGlobsOf(rule: IWiringRule): string[] {
  return wiringSourcesOf(rule).flatMap((s) => [...(s.files ?? [])]);
}

/**
 * The ordered `(source, sinks)` pairs a rule evaluates. A classic rule yields
 * one pair; a `chain` of n hops yields n-1 pairs, so `declared → registered →
 * wired` is one rule instead of three.
 */
function hopPairs(rule: IWiringRule): { from: IWiringSource; to: readonly IWiringSource[] }[] {
  if (rule.chain && rule.chain.length >= 2) {
    const pairs: { from: IWiringSource; to: readonly IWiringSource[] }[] = [];
    for (let i = 0; i < rule.chain.length - 1; i += 1) {
      pairs.push({ from: rule.chain[i]!, to: [rule.chain[i + 1]!] });
    }
    return pairs;
  }
  if (!rule.declared) return [];
  return [{ from: rule.declared, to: registeredSources(rule.registered) }];
}

/**
 * Public: extract every token site from ONE wiring source over the given files.
 * Shared by the wiring evaluator, the registry-inventory engine, and the
 * extractor-backed baseline compute, so all three honour identical semantics. A
 * misconfigured source returns an `error` and no sites (never throws).
 */
export function collectSourceSites(
  source: IWiringSource,
  files: readonly IWiringFileEntry[],
  context: IExtractContext = {},
): { sites: readonly IWiringTokenSite[]; error?: string; blankedChars?: number } {
  const res = extractTokens(source, files, context);
  if (res.error) return { sites: [], error: res.error };
  return {
    sites: res.sites,
    ...(res.blankedChars !== undefined ? { blankedChars: res.blankedChars } : {}),
  };
}

/** Group key for a token site under `groupBy` (dir = dirname; package = first two segments). */
function groupKeyOf(path: string, groupBy: 'dir' | 'package'): string {
  if (groupBy === 'package') return path.split('/').slice(0, 2).join('/');
  const idx = path.lastIndexOf('/');
  return idx >= 0 ? path.slice(0, idx) : '.';
}

/** Membership key combining the group (empty = global) and the token. */
function keyOf(site: IWiringTokenSite, groupBy?: 'dir' | 'package'): string {
  const g = groupBy ? groupKeyOf(site.file, groupBy) : '';
  return `${g} ${site.token}`;
}

/** First site per membership key, in stable (file, line) order. */
function firstSites(
  sites: readonly IWiringTokenSite[],
  groupBy?: 'dir' | 'package',
): Map<string, IWiringTokenSite> {
  const map = new Map<string, IWiringTokenSite>();
  for (const s of [...sites].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    const k = keyOf(s, groupBy);
    if (!map.has(k)) map.set(k, s);
  }
  return map;
}

/** Render a rule's `message` template against one violating site. */
function renderMessage(
  template: string,
  rule: IWiringRule,
  site: IWiringTokenSite,
): string {
  return template
    .replace(/\{id\}|\{token\}/g, site.token)
    .replace(/\{file\}/g, site.file)
    .replace(/\{line\}/g, String(site.line))
    .replace(/\{rule\}/g, rule.id);
}

/**
 * Registered sites whose membership key the declared side never produced,
 * sorted by key. The ONE derivation behind both parity's `registered-missing`
 * violations and a subset rule's coverage shortfall — two renderings of one set
 * difference, so they cannot disagree.
 */
function registeredNotDeclared(
  fromKeys: ReadonlyMap<string, IWiringTokenSite>,
  unionKeys: ReadonlyMap<string, IWiringTokenSite>,
): IWiringTokenSite[] {
  return [...unionKeys.keys()]
    .sort()
    .filter((k) => !fromKeys.has(k))
    .map((k) => unionKeys.get(k)!);
}

/** At most this many unexamined labels ride on one coverage record. */
const COVERAGE_LABEL_CAP = 20;

/** How a rule ended, as far as its coverage is concerned. */
type WiringCoverageOutcome =
  | { readonly kind: 'error' }
  | { readonly kind: 'skipped'; readonly reason: string }
  | {
      readonly kind: 'ran';
      readonly declaredCount: number;
      readonly registeredCount: number;
      readonly registeredOnly?: readonly IWiringTokenSite[];
    };

/**
 * What one wiring rule examined, for the verdict's coverage guard.
 *
 * Only a classic SUBSET rule can pass over a scope it never examined: its
 * relation is `declared ⊆ registered`, so a registered member the declared
 * selector never produced is never looked at, and the rule weakens silently
 * every time the tree grows past the selector. For it the unit is `registered
 * tokens`; `registeredExtras` (literal ids, or `'allow'`) accepts known extras
 * explicitly. Every other shape examines each declared token it extracted, so
 * its unit is `declared tokens`. A skipped or misconfigured rule examined
 * nothing.
 */
function wiringCoverage(rule: IWiringRule, outcome: WiringCoverageOutcome): IVerdictCoverage {
  if (outcome.kind === 'error') {
    return { unit: 'declared tokens', expected: 0, examined: 0, reason: 'the rule is misconfigured' };
  }
  if (outcome.kind === 'skipped') {
    return { unit: 'declared tokens', expected: 0, examined: 0, reason: outcome.reason };
  }
  const only = outcome.registeredOnly;
  const subset = rule.mode === undefined || rule.mode === 'subset';
  if (only === undefined || !subset || outcome.registeredCount === 0) {
    return { unit: 'declared tokens', expected: outcome.declaredCount, examined: outcome.declaredCount };
  }
  const extras = rule.registeredExtras;
  const listed = new Set(extras === 'allow' ? [] : (extras ?? []));
  const accepted = new Set(only.filter((s) => extras === 'allow' || listed.has(s.token)));
  const unaccepted = only.filter((s) => !accepted.has(s));
  const named = unaccepted.length > 0 ? unaccepted : [...accepted];
  return {
    unit: 'registered tokens',
    expected: outcome.registeredCount,
    examined: outcome.registeredCount - only.length,
    ...(named.length > 0
      ? {
          unexamined: named.slice(0, COVERAGE_LABEL_CAP).map((s) => s.token),
          unexaminedTotal: named.length,
          reason:
            unaccepted.length > 0 && accepted.size > 0
              ? `registered with no declared site this selector produces (${accepted.size} more accepted by registeredExtras)`
              : 'registered with no declared site this selector produces',
        }
      : {}),
    ...(unaccepted.length === 0 && accepted.size > 0
      ? { acceptedBy: extras === 'allow' ? "registeredExtras: 'allow'" : 'registeredExtras' }
      : {}),
  };
}

/** Structural validation of a whole rule (both forms), independent of the tree. */
export function validateWiringRule(rule: IWiringRule): string | undefined {
  const hasChain = Array.isArray(rule.chain) && rule.chain.length > 0;
  const hasClassic = rule.declared !== undefined || rule.registered !== undefined;
  if (hasChain && hasClassic) {
    return '`chain` is mutually exclusive with `declared`/`registered`';
  }
  if (
    rule.registeredExtras !== undefined &&
    (hasChain || (rule.mode !== undefined && rule.mode !== 'subset'))
  ) {
    return '`registeredExtras` applies only to a classic subset rule (parity reports registered-only tokens as violations; disjoint / chain rules never examine them)';
  }
  if (hasChain) {
    if (rule.chain!.length < 2) return '`chain` needs at least 2 hops';
    if (rule.mode !== undefined && rule.mode !== 'subset') {
      return `\`mode: ${rule.mode}\` is not supported on a chain rule (each hop is a subset relation)`;
    }
  } else {
    if (!rule.declared) return 'sets no `declared` source (or use `chain`)';
    if (registeredSources(rule.registered).length === 0) {
      return 'sets no `registered` source (or use `chain`)';
    }
  }
  for (const [i, src] of wiringSourcesOf(rule).entries()) {
    const err = validateWiringSource(src);
    if (err) {
      const label = hasChain ? `chain[${i}]` : i === 0 ? 'declared' : `registered[${i - 1}]`;
      return `${label} ${err}`;
    }
  }
  return undefined;
}

/**
 * Pure wiring evaluation.
 *
 * For each rule the SOURCE token set is compared against the SINK sets per
 * `mode` (`subset` / `parity` / `disjoint`) and `registeredMode` (`union` /
 * `intersection`). A `chain` rule runs the same comparison across each adjacent
 * hop pair. With `groupBy`, membership is checked within the same dir/package.
 *
 * Three outcomes are kept distinct, because collapsing them is what makes a
 * homegrown gate untrustworthy: a rule that PASSED, a rule that FAILED, and a
 * rule that checked NOTHING (`skipped`, promoted to a failure by `failOnEmpty`).
 *
 * The `resolve` callback supplies the files for a given rule-side (injected so
 * the engine stays pure / testable — see `runWiring` for the fs-backed wiring).
 *
 * `unreadFor` supplies the files a side's globs matched that the one reader
 * did NOT read. A rule with any in its scope has its coverage replaced by the
 * file record (`readScopeCoverage`), so it is never a pass. When the unread
 * file is on the source side and is why the rule compared nothing, the rule is
 * PARTIAL rather than a (failOnEmpty) skip: it matched a file it could not read.
 *
 * `emptiedBy` names the negations that excluded EVERY file a source's
 * inclusion globs matched (`undefined` when the list was not emptied that
 * way). A source side emptied by its own `!` entries is skipped with THE
 * negation-aware reason (`matched nothing after its own negations: …`), never
 * "0 files matched the source globs" — a file matched, then was excluded.
 */
export function evaluateWiring(
  rules: readonly IWiringRule[],
  resolve: WiringFileResolver,
  context: IExtractContext = {},
  unreadFor?: (source: IWiringSource) => readonly IUnreadFile[],
  emptiedBy?: (source: IWiringSource) => readonly IGlobNegation[] | undefined,
  /**
   * Every source's glob units settled with their `expectEmpty` markers
   * (round 13) — `runWiring` supplies it (`sourceLivenessRequest` over the
   * engine's side labels, `settleGlobLists`). A rule whose source side matched
   * nothing is decided from it by THE rule-emptiness settle
   * (`settleRuleEmptiness`): every inclusion glob of the source side
   * intended-empty and no file matched → accepted, never a skip. Its
   * acceptance and non-live units ride on the rule result. Absent: no unit is
   * marked, so an empty rule is a loud skip exactly as before.
   */
  ruleLivenessOf?: (rule: IWiringRule) => ISettledUnitLiveness,
): IWiringReport {
  const ruleResults: IWiringRuleResult[] = [];
  const all: IWiringViolation[] = [];
  const diagnostics: string[] = [];
  const skipped: IWiringSkip[] = [];
  let evaluated = 0;
  let acceptedEmpty = 0;
  let misconfigError = false;
  let misconfigWarn = false;

  for (const authored of rules) {
    const severity: 'error' | 'warning' = authored.severity ?? 'error';
    // The engine entry normalises idempotently (round 13): a loaded rule comes
    // back equal; a hand-built `{ pattern, expectEmpty }` entry is a glob plus
    // a marker; a malformed entry is a misconfigured rule — never a crash.
    const normalized = normalizeWiringRule(authored);
    if (!normalized.ok) {
      const msg = `rule "${authored.id}": ${normalized.error.message}`;
      diagnostics.push(msg);
      if (severity === 'error') misconfigError = true;
      else misconfigWarn = true;
      ruleResults.push({
        ruleId: authored.id,
        ...(authored.description ? { description: authored.description } : {}),
        severity,
        status: 'error',
        declaredCount: 0,
        registeredCount: 0,
        declaredFiles: 0,
        registeredFiles: 0,
        violations: [],
        error: msg,
        coverage: wiringCoverage(authored, { kind: 'error' }),
      });
      evaluated += 1;
      continue;
    }
    const rule = normalized.value;
    const groupBy = rule.groupBy;

    // Validate defensively — a misconfigured rule becomes a diagnostic, never a
    // thrown exception that would crash the gate.
    const structural = validateWiringRule(rule);
    if (structural) {
      const msg = `rule "${rule.id}": ${structural}`;
      diagnostics.push(msg);
      if (severity === 'error') misconfigError = true;
      else misconfigWarn = true;
      ruleResults.push({
        ruleId: rule.id,
        ...(rule.description ? { description: rule.description } : {}),
        severity,
        status: 'error',
        declaredCount: 0,
        registeredCount: 0,
        declaredFiles: 0,
        registeredFiles: 0,
        violations: [],
        error: msg,
        coverage: wiringCoverage(rule, { kind: 'error' }),
      });
      // A misconfigured rule attempted to run — count it so its error isn't
      // swallowed by the gate's `evaluated === 0` skip path.
      evaluated += 1;
      continue;
    }

    // The rule's glob units and their `expectEmpty` markers (round 13): the
    // acceptance, the printed unit lines and the non-live units ride on every
    // result below, so `check wiring` accepts a planned glob the way `gates
    // coverage` does.
    const liveness = ruleLivenessOf?.(rule);
    const nonLive = liveness?.units.filter((u) => u.state !== UnitLivenessState.Live) ?? [];
    const unitFields = {
      ...(liveness?.acceptance !== undefined ? { unitAcceptance: liveness.acceptance } : {}),
      ...(liveness !== undefined && liveness.dead.length + liveness.intendedEmpty.length + liveness.wentLive.length > 0
        ? { units: unitStateLists(liveness) }
        : {}),
      ...(nonLive.length > 0 ? { unitLiveness: nonLive } : {}),
    };
    const pairs = hopPairs(rule);
    const violations: IWiringViolation[] = [];
    const hops: IWiringHopResult[] = [];
    let sourceFiles = 0;
    let sourceCount = 0;
    let sinkFiles = 0;
    let sinkCount = 0;
    let emptySink = false;
    let sinkHint: string | undefined;
    // Registered sites no declared site produced — classic (one-hop) rules only.
    let registeredOnly: IWiringTokenSite[] | undefined;
    // Every file any side READ (for the read scope), and the last hop's sinks'
    // unread files (to explain an empty sink that was simply never read).
    const readPaths = new Set<string>();
    let sinkUnread: readonly IUnreadFile[] = [];

    for (const [hopIndex, pair] of pairs.entries()) {
      const fromFiles = resolve(pair.from);
      for (const f of fromFiles) readPaths.add(f.path);
      const fromSites = extractTokens(pair.from, fromFiles, context).sites;
      const fromKeys = firstSites(fromSites, groupBy);

      // Each sink kept separate so `intersection` can require membership in ALL.
      const sinkKeySets: Map<string, IWiringTokenSite>[] = [];
      let hopSinkFiles = 0;
      sinkUnread = unreadFor ? pair.to.flatMap((s) => unreadFor(s)) : [];
      for (const sink of pair.to) {
        const files = resolve(sink);
        for (const f of files) readPaths.add(f.path);
        hopSinkFiles += files.length;
        const sinkRes = extractTokens(sink, files, context);
        if (sinkRes.hint && sinkHint === undefined) sinkHint = sinkRes.hint;
        sinkKeySets.push(firstSites(sinkRes.sites, groupBy));
      }
      const unionKeys = new Map<string, IWiringTokenSite>();
      for (const set of sinkKeySets) {
        for (const [k, v] of set) if (!unionKeys.has(k)) unionKeys.set(k, v);
      }
      const inSink = (k: string): boolean =>
        rule.registeredMode === 'intersection'
          ? sinkKeySets.length > 0 && sinkKeySets.every((s) => s.has(k))
          : unionKeys.has(k);

      if (hopIndex === 0) {
        sourceFiles = fromFiles.length;
        sourceCount = fromKeys.size;
      }
      // The reported sink side is the LAST hop's — the end of the chain.
      sinkFiles = hopSinkFiles;
      sinkCount = unionKeys.size;
      if (fromKeys.size > 0 && unionKeys.size === 0) emptySink = true;

      const declaredHint = rule.hintDeclaredMissing ?? rule.hint;
      let missing = 0;
      if (rule.mode === 'disjoint') {
        for (const k of [...fromKeys.keys()].sort()) {
          if (!inSink(k)) continue;
          const site = fromKeys.get(k)!;
          missing += 1;
          violations.push({
            ruleId: rule.id,
            token: site.token,
            file: site.file,
            line: site.line,
            severity,
            direction: 'overlap',
            ...(pairs.length > 1 ? { hop: hopIndex } : {}),
            ...(rule.message ? { message: renderMessage(rule.message, rule, site) } : {}),
            ...(declaredHint ? { hint: declaredHint } : {}),
          });
        }
      } else {
        for (const k of [...fromKeys.keys()].sort()) {
          if (inSink(k)) continue;
          const site = fromKeys.get(k)!;
          missing += 1;
          violations.push({
            ruleId: rule.id,
            token: site.token,
            file: site.file,
            line: site.line,
            severity,
            direction: 'declared-missing',
            ...(pairs.length > 1 ? { hop: hopIndex } : {}),
            ...(rule.message ? { message: renderMessage(rule.message, rule, site) } : {}),
            ...(declaredHint ? { hint: declaredHint } : {}),
          });
        }
        // ONE set difference, two renderings: parity FAILS on each registered
        // token no declared site produced; subset records them as unexamined
        // (its coverage shortfall). Only a classic one-hop rule carries the
        // set — a chain hop keeps the declared-token view.
        const regOnly = registeredNotDeclared(fromKeys, unionKeys);
        if (pairs.length === 1) registeredOnly = regOnly;
        if (rule.mode === 'parity') {
          const registeredHint = rule.hintRegisteredMissing ?? rule.hint;
          for (const site of regOnly) {
            violations.push({
              ruleId: rule.id,
              token: site.token,
              file: site.file,
              line: site.line,
              severity,
              direction: 'registered-missing',
              ...(rule.message ? { message: renderMessage(rule.message, rule, site) } : {}),
              ...(registeredHint ? { hint: registeredHint } : {}),
            });
          }
        }
      }
      hops.push({ index: hopIndex, fromCount: fromKeys.size, toCount: unionKeys.size, missing });
    }

    // What the rule's walk covered: every file any side read, and every file
    // any side's globs matched that the reader did not read.
    const scope = unreadFor
      ? mergeReadScopes(
          readPaths.size,
          wiringSourcesOf(rule).map((s) => unreadFor(s)),
        )
      : undefined;
    const unreadField = scope !== undefined && scope.unread.length > 0 ? { unread: scope.unread } : {};
    // An empty sink whose files were never READ is not a stale glob — say so,
    // or the reader is sent to fix a selector that is fine.
    if (emptySink && sinkUnread.length > 0) {
      sinkHint = `the registered side ${describeUnread(sinkUnread)} was never read, so a token registered there cannot be seen`;
    }

    // Loud skip: the SOURCE side checked nothing. Deliberately NOT triggered by
    // an empty sink — that is a real failure, flagged via `emptySink` instead.
    // A source its OWN negations emptied is worded as such (round 12 review,
    // R12-DOC-2), exactly as `gates coverage` and `policy-lint` word it.
    const firstSource = pairs[0]?.from;
    const emptiedByOwn = sourceFiles === 0 && firstSource ? emptiedBy?.(firstSource) : undefined;
    const skipReason =
      sourceFiles === 0
        ? emptiedByOwn !== undefined && emptiedByOwn.length > 0
          ? emptiedByNegationsReason(emptiedByOwn)
          : '0 files matched the source globs'
        : sourceCount === 0
          ? '0 ids extracted from the source side'
          : undefined;
    const sourceSide = pairs[0]?.from;
    const sourceUnread = sourceSide && unreadFor ? unreadFor(sourceSide) : [];
    if (skipReason !== undefined && readScopeHasUnread({ read: sourceFiles, unread: sourceUnread })) {
      // The source side's zero comes from a file the reader could not read,
      // not from a stale selector: PARTIAL (its coverage names the file),
      // never failOnEmpty's failure and never a pass. Nothing was compared,
      // so no violation derived from the incomplete side is reported.
      ruleResults.push({
        ruleId: rule.id,
        ...(rule.description ? { description: rule.description } : {}),
        severity,
        status: 'passed',
        declaredCount: sourceCount,
        registeredCount: sinkCount,
        declaredFiles: sourceFiles,
        registeredFiles: sinkFiles,
        violations: [],
        ...(pairs.length > 1 ? { hops } : {}),
        ...unreadField,
        ...unitFields,
        coverage: readScopeCoverage(wiringCoverage(rule, { kind: 'skipped', reason: skipReason }), scope),
      });
      evaluated += 1;
      continue;
    }
    if (skipReason !== undefined) {
      // THE rule-emptiness settle (round 13, `settleRuleEmptiness`): every
      // inclusion glob of the SOURCE side marked `expectEmpty` and no file
      // matched → the empty result is the intended one, accepted and printed.
      // Anything else is the loud skip it always was (failOnEmpty's 1, else 2):
      // `0 ids extracted` from live files is never assertable.
      const primaryLabel = (rule.chain?.length ?? 0) > 0 ? 'chain[0]' : 'declared';
      const emptied = emptiedByOwn !== undefined && emptiedByOwn.length > 0;
      const emptiness = settleRuleEmptiness({
        subject: rule.id,
        unitLabel: 'declared tokens',
        filesMatched: sourceFiles,
        unitsMatched: sourceCount,
        unread: false,
        emptiedByNegations: emptied,
        ...(emptied ? { emptiedReason: skipReason } : {}),
        liveness: liveness ?? settleGlobLists({ subject: rule.id, lists: [], marks: [] }),
        primaryLists: [`${primaryLabel}.files`],
        failOnEmpty: failsWhenEmpty(rule),
        noFilesReason: '0 files matched the source globs',
        noUnitsReason: '0 ids extracted from the source side',
      });
      if (emptiness.state === RuleEmptiness.IntendedEmpty && emptiness.coverage !== undefined) {
        ruleResults.push({
          ruleId: rule.id,
          ...(rule.description ? { description: rule.description } : {}),
          severity,
          status: 'passed',
          declaredCount: sourceCount,
          registeredCount: sinkCount,
          declaredFiles: sourceFiles,
          registeredFiles: sinkFiles,
          violations: [],
          ...(pairs.length > 1 ? { hops } : {}),
          ...unreadField,
          ...unitFields,
          // The acceptance IS the rule's coverage (the same record, folded once).
          coverage: emptiness.coverage,
        });
        // Counted in `evaluated` (the verdict path's "nothing ran" guard must
        // never read an accepted plan as a skip) AND in `acceptedEmpty`, which
        // a renderer subtracts: `N evaluated, M accepted as intended-empty`.
        evaluated += 1;
        acceptedEmpty += 1;
        continue;
      }
      const reason = emptiness.skipReason ?? skipReason;
      const failed = emptiness.fails;
      skipped.push({ ruleId: rule.id, reason, failed, severity });
      if (failed) {
        if (severity === 'error') misconfigError = true;
        else misconfigWarn = true;
      }
      ruleResults.push({
        ruleId: rule.id,
        ...(rule.description ? { description: rule.description } : {}),
        severity,
        status: failed ? 'failed' : 'skipped',
        declaredCount: sourceCount,
        registeredCount: sinkCount,
        declaredFiles: sourceFiles,
        registeredFiles: sinkFiles,
        violations: [],
        ...(pairs.length > 1 ? { hops } : {}),
        ...unreadField,
        ...unitFields,
        coverage: readScopeCoverage(wiringCoverage(rule, { kind: 'skipped', reason }), scope),
      });
      continue;
    }

    ruleResults.push({
      ruleId: rule.id,
      ...(rule.description ? { description: rule.description } : {}),
      severity,
      status: violations.length > 0 ? 'failed' : 'passed',
      declaredCount: sourceCount,
      registeredCount: sinkCount,
      declaredFiles: sourceFiles,
      registeredFiles: sinkFiles,
      violations,
      ...(emptySink ? { emptySink: true } : {}),
      ...(emptySink && sinkHint !== undefined ? { sinkHint } : {}),
      ...(pairs.length > 1 ? { hops } : {}),
      ...(registeredOnly !== undefined ? { registeredOnly } : {}),
      ...unreadField,
      ...unitFields,
      coverage: readScopeCoverage(
        wiringCoverage(rule, {
          kind: 'ran',
          declaredCount: sourceCount,
          registeredCount: sinkCount,
          ...(registeredOnly !== undefined ? { registeredOnly } : {}),
        }),
        scope,
      ),
    });
    all.push(...violations);
    evaluated += 1;
  }

  // A misconfigured rule (or a failOnEmpty skip) must not pass as a silent
  // green — it counts toward the verdict at its own severity (default error).
  const hasError = misconfigError || all.some((v) => v.severity === 'error');
  const hasWarn = misconfigWarn || all.some((v) => v.severity === 'warning');
  return {
    schema: WIRING_SCHEMA,
    rules: ruleResults,
    violations: all,
    diagnostics,
    skipped,
    evaluated,
    acceptedEmpty,
    verdict: hasError ? 'errors' : hasWarn ? 'warnings' : 'pass',
  };
}
