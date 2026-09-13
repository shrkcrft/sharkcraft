import {
  failsWhenEmpty,
  normalizeRuleList,
  RuleEmptiness,
  settleRuleEmptiness,
  type IPolicyRule,
  type IUnitLiveness,
  type IUnitStateLists,
  type IVerdictCoverage,
  type PolicyScanZone,
  type PolicySurface,
} from '@shrkcrft/core';
import { lexCodeZones, zoneKeepsAt } from '../extract/code-zones.ts';
import { allExcludedCause } from '../util/negation-cause.ts';
import { settleGlobLists } from '../util/settle-glob-lists.ts';
import type { IPolicyRuleLiveness } from './i-policy-rule-liveness.ts';
import type { IReadScope } from '../util/read-scope.ts';
import type { IUnreadFile } from '../util/unread-file.ts';
import type { IDeadGlobUnit } from '../util/i-dead-glob-unit.ts';
import type { IGlobNegation } from '../util/i-glob-negation.ts';
import { readScopeCoverage, readScopeHasUnread } from '../util/read-scope-coverage.ts';
import { safeCompile } from '../util/safe-regex.ts';

export const POLICY_LINT_SCHEMA = 'sharkcraft.policy-lint/v1' as const;

/**
 * A chunk of content to scan for one rule. For whole files `baseLine` is 1; for
 * an inline template it is the source line where the template body begins, so
 * findings map back to the real file line.
 */
export interface IPolicyUnit {
  readonly path: string;
  readonly content: string;
  readonly baseLine: number;
  /** Marks an inline-template unit (for clearer reporting). */
  readonly inlineTemplate?: boolean;
  /** True when the file matched one of the rule's `exemptFiles` globs. */
  readonly exemptFile?: boolean;
}

export interface IPolicyFinding {
  readonly ruleId: string;
  readonly surface: PolicySurface;
  readonly file: string;
  readonly line: number;
  /** The matched token (capture group 1 if present, else the whole match, truncated). */
  readonly match: string;
  readonly message: string;
  readonly suggest?: string;
  readonly severity: 'error' | 'warning';
  readonly inlineTemplate?: boolean;
}

/** A hit that WAS matched but dropped by an exemption — kept so it can be shown. */
export interface IPolicySuppression {
  readonly ruleId: string;
  readonly file: string;
  readonly line: number;
  readonly match: string;
  /** Which exemption applied. */
  readonly via: 'exemptFiles' | 'exemptLines' | 'scanZone';
}

/**
 * Per-rule outcome. `skipped` is DISTINCT from `passed`: a rule that scanned no
 * units checked nothing, and calling that a pass is exactly how a stale glob
 * ships a real violation.
 */
export type PolicyRuleStatus = 'passed' | 'failed' | 'skipped' | 'error';

export interface IPolicyRuleResult {
  readonly ruleId: string;
  readonly surface: PolicySurface;
  readonly severity: 'error' | 'warning';
  readonly status: PolicyRuleStatus;
  readonly findingCount: number;
  /** Hits dropped by an exemption (still counted, never silent). */
  readonly suppressedCount: number;
  /** Content units actually scanned — the stale-glob signal. */
  readonly unitsScanned: number;
  readonly error?: string;
  /**
   * What the rule examined against what it was asked to (`IVerdictCoverage`,
   * unit `content units`) — the ONE per-rule record `policy-lint`, `gates
   * check`, `quality`, `shrk gate` and `finish` all settle on. A rule that
   * scanned nothing, or is misconfigured, examined nothing (`expected: 0` — a
   * shortfall). The engine fills it in; it never decides a verdict from it.
   */
  readonly coverage: IVerdictCoverage;
  /**
   * Glob-matched files in the rule's scope that the one reader did not read
   * (over the read cap, or unreadable). Set only when non-empty. `coverage`
   * names them too: such a rule is never a pass.
   */
  readonly unread?: readonly IUnreadFile[];
  /**
   * Globs of the rule's own `files[]` that do nothing — an inclusion glob
   * that selects no file in the walk, or a negation that excludes none — a
   * dead unit inside a rule whose other globs keep it scanning. Set only when
   * non-empty, and only for author-written `files` (a surface's default globs
   * are not the author's selector). Advisory; `gates coverage` reports it.
   */
  readonly deadGlobs?: readonly string[];
  /** The units behind {@link deadGlobs}, same order, each with its reason (`globListUnits`). */
  readonly deadGlobUnits?: readonly IDeadGlobUnit[];
  /** Live negations of the rule's own `files[]`, each with the files it excludes. Set only when non-empty. */
  readonly negations?: readonly IGlobNegation[];
  /**
   * Set only when the rule scanned nothing BECAUSE of its own `files[]`
   * negations: its inclusion globs matched files and these negations excluded
   * every one (`globListUnits`' `allExcluded`). That is not a stale selector,
   * so its skip reason and coverage reason say what happened instead.
   */
  readonly excludedByNegations?: readonly IGlobNegation[];
  /**
   * The acceptance of the rule's `expectEmpty` units — settle record B of its
   * `files` (round 13). Folded into the envelope's ONE settle beside
   * {@link coverage}; when the rule is intended-empty it IS {@link coverage}.
   */
  readonly unitAcceptance?: IVerdictCoverage;
  /** The rule's dead / intended-empty / went-live `files` units as printed lines (`unitStateLists`). */
  readonly units?: IUnitStateLists;
  /** The rule's non-live `files` units (dead, intended-empty, went-live, unproven), for `--fail-on-dead-units` (`selectorUnitFails`). */
  readonly unitLiveness?: readonly IUnitLiveness[];
}

/** A rule that scanned nothing, reported loudly instead of as a green pass. */
export interface IPolicySkip {
  readonly ruleId: string;
  readonly reason: string;
  /** True when the rule set `failOnEmpty` — the skip counts as a failure. */
  readonly failed: boolean;
  readonly severity: 'error' | 'warning';
}

export interface IPolicyReport {
  readonly schema: typeof POLICY_LINT_SCHEMA;
  readonly rules: readonly IPolicyRuleResult[];
  readonly findings: readonly IPolicyFinding[];
  readonly diagnostics: readonly string[];
  /** Hits an exemption dropped — surfaced by `policy-lint explain`. */
  readonly suppressed: readonly IPolicySuppression[];
  /** Rules that scanned nothing. */
  readonly skipped: readonly IPolicySkip[];
  /**
   * Count of rules that actually scanned ≥1 unit. A rule whose globs matched 0
   * files (e.g. a `style` rule in a project with no stylesheets) is NOT
   * evaluated — a loud skip rather than a green pass. Misconfigured rules count
   * as evaluated so their error is not swallowed, and so does a rule whose
   * globs matched a file the reader could not read (it ran, and is PARTIAL:
   * its coverage names the unread file). A rule ACCEPTED as intended-empty
   * (round 13 — every inclusion glob of its `files` marked `expectEmpty`, 0
   * files matched) is counted too, so the verdict path's `evaluated === 0`
   * NOT-VERIFIED guard never reads an accepted plan as "nothing ran"; the
   * printed "N evaluated" excludes it: N = `evaluated − acceptedEmpty`.
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

/** Resolves the content units to scan for a given rule (injected for purity/testability). */
export type PolicyUnitResolver = (rule: IPolicyRule) => readonly IPolicyUnit[];

function lineWithin(content: string, index: number): number {
  let line = 1;
  const end = Math.min(index, content.length);
  for (let i = 0; i < end; i += 1) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}

function truncate(s: string, max = 120): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

/** Does the marker appear on `line` (1-based, within `lines`) or the one above it? */
function markerNear(lines: readonly string[], line: number, marker: string): boolean {
  const here = lines[line - 1];
  if (here !== undefined && here.includes(marker)) return true;
  const above = lines[line - 2];
  return above !== undefined && above.includes(marker);
}

/**
 * Whether the zone rule keeps a match at `index`.
 *
 * Delegates the zone semantics to {@link zoneKeepsAt} — the one authority the
 * extraction DSL also reads — and adds only the policy-specific exemption:
 * inline-template units are NOT zoned, because their content is already a
 * string body lifted out of a source file.
 */
function zoneKeeps(
  zone: PolicyScanZone,
  unit: IPolicyUnit,
  zones: ReturnType<typeof lexCodeZones> | undefined,
  index: number,
): boolean {
  if (zone === 'all' || unit.inlineTemplate || zones === undefined) return true;
  return zoneKeepsAt(zone, zones, index);
}

/** How a rule ended, as far as its coverage is concerned. */
type PolicyCoverageOutcome =
  | { readonly kind: 'error' }
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'ran'; readonly units: number };

/** Why a rule that scanned no content unit examined nothing. */
const NO_UNITS_REASON = '0 content units matched the rule globs';

/**
 * What one policy rule examined: every content unit its globs matched (whole
 * files, or inline-template bodies). A rule that scanned nothing, or is
 * misconfigured, examined nothing — `expected: 0`, which core's
 * `coverageShortfall` reports as a gap. The one derivation; every surface that
 * settles a policy verdict reads the record this puts on the rule result.
 */
function policyCoverage(outcome: PolicyCoverageOutcome): IVerdictCoverage {
  const unit = 'content units';
  if (outcome.kind === 'error') return { unit, expected: 0, examined: 0, reason: 'the rule is misconfigured' };
  if (outcome.kind === 'skipped') return { unit, expected: 0, examined: 0, reason: outcome.reason };
  return { unit, expected: outcome.units, examined: outcome.units };
}

/**
 * Pure policy evaluation. Each rule's regex is run over the units the resolver
 * supplies; matches become findings (capture group 1 is the reported token when
 * present). Exemptions (`exemptFiles` / `exemptLines`) and the lexical `scan`
 * zone drop hits into {@link IPolicyReport.suppressed} rather than deleting
 * them, so `explain` can show what was matched AND what was let through. A
 * misconfigured rule (uncompilable regex) degrades to a diagnostic — never
 * throws, so one bad rule cannot crash the check.
 *
 * `scopeOf` reports each rule's read scope: the glob-matched files the one
 * reader read and the ones it did not. A rule with an unread file in scope
 * examined less than its globs matched, so its coverage is the file record
 * (`readScopeCoverage`) and it is never a pass. When the unread file is why it
 * scanned no unit at all, it is PARTIAL, not a `failOnEmpty` failure: it
 * matched something it could not read, which is not "matched nothing".
 */
export function evaluatePolicy(
  rules: readonly IPolicyRule[],
  resolve: PolicyUnitResolver,
  scopeOf?: (rule: IPolicyRule) => IReadScope,
  /**
   * The rule's own `files` judged per unit and settled with its `expectEmpty`
   * markers (round 13) — `runPolicyLint` supplies it from the walk it already
   * did. A rule that scanned nothing is decided from it by THE rule-emptiness
   * settle (`settleRuleEmptiness`): every inclusion glob intended-empty and no
   * file matched → accepted (`passed`, the acceptance as its coverage), never a
   * failOnEmpty failure. Absent (hand-driven, or no own `files`): no unit is
   * marked, so an empty rule is a loud skip exactly as before.
   */
  livenessOf?: (rule: IPolicyRule) => IPolicyRuleLiveness | undefined,
): IPolicyReport {
  const ruleResults: IPolicyRuleResult[] = [];
  const findings: IPolicyFinding[] = [];
  const suppressed: IPolicySuppression[] = [];
  const diagnostics: string[] = [];
  const skipped: IPolicySkip[] = [];
  let evaluated = 0;
  let acceptedEmpty = 0;
  let misconfigError = false;
  let misconfigWarn = false;

  for (const authored of rules) {
    const severity: 'error' | 'warning' = authored.severity ?? 'error';
    // The engine entry normalises idempotently (round 13): a loaded rule comes
    // back as the SAME object; a hand-built `{ pattern, expectEmpty }` entry is
    // a unit plus a marker; a malformed entry is a misconfigured rule — never
    // an object handed to a glob reader, never a crash.
    const normalized = normalizeRuleList(authored, 'files');
    if (!normalized.ok) {
      const msg = `rule "${authored.id}": ${normalized.error.message}`;
      diagnostics.push(msg);
      if (severity === 'error') misconfigError = true;
      else misconfigWarn = true;
      ruleResults.push({
        ruleId: authored.id,
        surface: authored.surface,
        severity,
        status: 'error',
        findingCount: 0,
        suppressedCount: 0,
        unitsScanned: 0,
        error: msg,
        coverage: policyCoverage({ kind: 'error' }),
      });
      evaluated += 1;
      continue;
    }
    const rule = normalized.value;
    const lv = livenessOf?.(rule);
    const acceptance = lv?.liveness.acceptance;
    const acceptanceField = acceptance !== undefined ? { unitAcceptance: acceptance } : {};
    const { re, error } = safeCompile(rule.pattern, rule.flags);
    if (error || !re) {
      const msg = `rule "${rule.id}": ${error}`;
      diagnostics.push(msg);
      if (severity === 'error') misconfigError = true;
      else misconfigWarn = true;
      ruleResults.push({
        ruleId: rule.id,
        surface: rule.surface,
        severity,
        status: 'error',
        findingCount: 0,
        suppressedCount: 0,
        unitsScanned: 0,
        error: msg,
        coverage: policyCoverage({ kind: 'error' }),
      });
      // A misconfigured rule attempted to run — count it as evaluated so its
      // error isn't swallowed by the gate's `evaluated === 0` skip path.
      evaluated += 1;
      continue;
    }

    const units = resolve(rule);
    const zone: PolicyScanZone = rule.scan ?? 'all';
    let count = 0;
    let suppressedCount = 0;
    let zeroWidth = false;
    for (const unit of units) {
      const lines = rule.exemptLines ? unit.content.split('\n') : undefined;
      const zones = zone !== 'all' && !unit.inlineTemplate ? lexCodeZones(unit.content) : undefined;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(unit.content)) !== null) {
        if (m[0] === '') {
          // A zero-width pattern (`a?`, a lookahead, …) would otherwise emit one
          // empty finding per position. Advance and refuse to record; flag it.
          zeroWidth = true;
          re.lastIndex += 1;
          continue;
        }
        const token = m[1] !== undefined ? m[1] : m[0];
        const localLine = lineWithin(unit.content, m.index);
        const line = unit.baseLine - 1 + localLine;
        const match = truncate(token);
        if (unit.exemptFile) {
          suppressed.push({ ruleId: rule.id, file: unit.path, line, match, via: 'exemptFiles' });
          suppressedCount += 1;
          continue;
        }
        if (!zoneKeeps(zone, unit, zones, m.index)) {
          suppressed.push({ ruleId: rule.id, file: unit.path, line, match, via: 'scanZone' });
          suppressedCount += 1;
          continue;
        }
        if (lines && markerNear(lines, localLine, rule.exemptLines!)) {
          suppressed.push({ ruleId: rule.id, file: unit.path, line, match, via: 'exemptLines' });
          suppressedCount += 1;
          continue;
        }
        findings.push({
          ruleId: rule.id,
          surface: rule.surface,
          file: unit.path,
          line,
          match,
          message: rule.message,
          ...(rule.suggest ? { suggest: rule.suggest } : {}),
          severity,
          ...(unit.inlineTemplate ? { inlineTemplate: true } : {}),
        });
        count += 1;
      }
    }

    if (zeroWidth) {
      const msg = `rule "${rule.id}": pattern matches the empty string (zero-width) — likely a misconfiguration`;
      diagnostics.push(msg);
      if (severity === 'error') misconfigError = true;
      else misconfigWarn = true;
      ruleResults.push({
        ruleId: rule.id,
        surface: rule.surface,
        severity,
        status: 'error',
        findingCount: count,
        suppressedCount,
        unitsScanned: units.length,
        error: msg,
        coverage: policyCoverage({ kind: 'error' }),
      });
      evaluated += 1;
      continue;
    }

    const scope = scopeOf?.(rule);
    const unreadField = scope !== undefined && scope.unread.length > 0 ? { unread: scope.unread } : {};
    if (units.length === 0 && readScopeHasUnread(scope)) {
      // Its globs matched files, but the reader could not read them. That is
      // not a stale glob: it ran over everything readable (nothing) and is
      // PARTIAL, naming the unread files. Never failOnEmpty's 1, never a pass.
      evaluated += 1;
      ruleResults.push({
        ruleId: rule.id,
        surface: rule.surface,
        severity,
        status: 'passed',
        findingCount: 0,
        suppressedCount: 0,
        unitsScanned: 0,
        ...unreadField,
        ...acceptanceField,
        coverage: readScopeCoverage(policyCoverage({ kind: 'skipped', reason: NO_UNITS_REASON }), scope),
      });
      continue;
    }

    if (units.length === 0) {
      // THE rule-emptiness settle (round 13, `settleRuleEmptiness`): every
      // inclusion glob of the rule's own `files` marked `expectEmpty` and no
      // file matched → the empty result is the INTENDED one, accepted and
      // printed; anything else — a dead or unmarked glob, files that yielded no
      // content unit — is the loud skip it always was (failOnEmpty's 1, else 2).
      const emptiedBy = lv?.units.allExcluded === true ? lv.units.negations : undefined;
      const emptiness = settleRuleEmptiness({
        subject: rule.id,
        unitLabel: 'content units',
        filesMatched: scope?.read ?? 0,
        unitsMatched: 0,
        unread: false,
        emptiedByNegations: emptiedBy !== undefined,
        ...(emptiedBy !== undefined ? { emptiedReason: `0 content units: ${allExcludedCause(emptiedBy)}` } : {}),
        liveness: lv?.liveness ?? settleGlobLists({ subject: rule.id, lists: [], marks: [] }),
        primaryLists: ['files'],
        failOnEmpty: failsWhenEmpty(rule),
        noFilesReason: NO_UNITS_REASON,
        noUnitsReason: NO_UNITS_REASON,
      });
      if (emptiness.state === RuleEmptiness.IntendedEmpty && emptiness.coverage !== undefined) {
        // Counted in `evaluated` (the verdict path's "nothing ran" guard must
        // never read an accepted plan as a skip) AND in `acceptedEmpty`, which
        // a renderer subtracts: `N evaluated, M accepted as intended-empty`.
        evaluated += 1;
        acceptedEmpty += 1;
        ruleResults.push({
          ruleId: rule.id,
          surface: rule.surface,
          severity,
          status: 'passed',
          findingCount: 0,
          suppressedCount: 0,
          unitsScanned: 0,
          ...unreadField,
          // The acceptance IS the rule's coverage (the same record, folded once).
          coverage: emptiness.coverage,
          unitAcceptance: emptiness.coverage,
        });
        continue;
      }
      const failed = emptiness.fails;
      const reason = emptiness.skipReason ?? NO_UNITS_REASON;
      skipped.push({ ruleId: rule.id, reason, failed, severity });
      if (failed) {
        if (severity === 'error') misconfigError = true;
        else misconfigWarn = true;
      }
      ruleResults.push({
        ruleId: rule.id,
        surface: rule.surface,
        severity,
        status: failed ? 'failed' : 'skipped',
        findingCount: 0,
        suppressedCount: 0,
        unitsScanned: 0,
        ...unreadField,
        ...acceptanceField,
        coverage: readScopeCoverage(
          policyCoverage({ kind: 'skipped', reason: emptiedBy !== undefined ? allExcludedCause(emptiedBy) : reason }),
          scope,
        ),
      });
      continue;
    }

    evaluated += 1;
    ruleResults.push({
      ruleId: rule.id,
      surface: rule.surface,
      severity,
      status: count > 0 ? 'failed' : 'passed',
      findingCount: count,
      suppressedCount,
      unitsScanned: units.length,
      ...unreadField,
      ...acceptanceField,
      coverage: readScopeCoverage(policyCoverage({ kind: 'ran', units: units.length }), scope),
    });
  }

  const hasError = misconfigError || findings.some((f) => f.severity === 'error');
  const hasWarn = misconfigWarn || findings.some((f) => f.severity === 'warning');
  return {
    schema: POLICY_LINT_SCHEMA,
    rules: ruleResults,
    findings,
    diagnostics,
    suppressed,
    skipped,
    evaluated,
    acceptedEmpty,
    verdict: hasError ? 'errors' : hasWarn ? 'warnings' : 'pass',
  };
}
