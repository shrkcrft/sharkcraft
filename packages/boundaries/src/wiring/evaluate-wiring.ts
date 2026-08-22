import {
  validateWiringSource,
  type IWiringRule,
  type IWiringSource,
} from '@shrkcrft/core';
import {
  extractTokens,
  type IExtractFileEntry,
  type IExtractedSite,
} from '../extract/extract-tokens.ts';

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
  /** Per-hop breakdown for a `chain` rule. */
  readonly hops?: readonly IWiringHopResult[];
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
   * Count of rules that actually ran a comparison. A rule whose source side
   * matched 0 files or extracted 0 ids is NOT evaluated (see {@link skipped}).
   * Misconfigured rules count as evaluated so their error is not swallowed.
   */
  readonly evaluated: number;
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
): { sites: readonly IWiringTokenSite[]; error?: string } {
  const res = extractTokens(source, files);
  return res.error ? { sites: [], error: res.error } : { sites: res.sites };
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

/** Structural validation of a whole rule (both forms), independent of the tree. */
export function validateWiringRule(rule: IWiringRule): string | undefined {
  const hasChain = Array.isArray(rule.chain) && rule.chain.length > 0;
  const hasClassic = rule.declared !== undefined || rule.registered !== undefined;
  if (hasChain && hasClassic) {
    return '`chain` is mutually exclusive with `declared`/`registered`';
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
 */
export function evaluateWiring(
  rules: readonly IWiringRule[],
  resolve: WiringFileResolver,
): IWiringReport {
  const ruleResults: IWiringRuleResult[] = [];
  const all: IWiringViolation[] = [];
  const diagnostics: string[] = [];
  const skipped: IWiringSkip[] = [];
  let evaluated = 0;
  let misconfigError = false;
  let misconfigWarn = false;

  for (const rule of rules) {
    const severity: 'error' | 'warning' = rule.severity ?? 'error';
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
      });
      // A misconfigured rule attempted to run — count it so its error isn't
      // swallowed by the gate's `evaluated === 0` skip path.
      evaluated += 1;
      continue;
    }

    const pairs = hopPairs(rule);
    const violations: IWiringViolation[] = [];
    const hops: IWiringHopResult[] = [];
    let sourceFiles = 0;
    let sourceCount = 0;
    let sinkFiles = 0;
    let sinkCount = 0;
    let emptySink = false;

    for (const [hopIndex, pair] of pairs.entries()) {
      const fromFiles = resolve(pair.from);
      const fromSites = extractTokens(pair.from, fromFiles).sites;
      const fromKeys = firstSites(fromSites, groupBy);

      // Each sink kept separate so `intersection` can require membership in ALL.
      const sinkKeySets: Map<string, IWiringTokenSite>[] = [];
      let hopSinkFiles = 0;
      for (const sink of pair.to) {
        const files = resolve(sink);
        hopSinkFiles += files.length;
        sinkKeySets.push(firstSites(extractTokens(sink, files).sites, groupBy));
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
        if (rule.mode === 'parity') {
          const registeredHint = rule.hintRegisteredMissing ?? rule.hint;
          for (const k of [...unionKeys.keys()].sort()) {
            if (fromKeys.has(k)) continue;
            const site = unionKeys.get(k)!;
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

    // Loud skip: the SOURCE side checked nothing. Deliberately NOT triggered by
    // an empty sink — that is a real failure, flagged via `emptySink` instead.
    const skipReason =
      sourceFiles === 0
        ? '0 files matched the source globs'
        : sourceCount === 0
          ? '0 ids extracted from the source side'
          : undefined;
    if (skipReason !== undefined) {
      const failed = rule.failOnEmpty === true;
      skipped.push({ ruleId: rule.id, reason: skipReason, failed, severity });
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
      ...(pairs.length > 1 ? { hops } : {}),
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
    verdict: hasError ? 'errors' : hasWarn ? 'warnings' : 'pass',
  };
}
