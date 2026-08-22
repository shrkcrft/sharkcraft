import type { IPolicyRule, PolicyScanZone, PolicySurface } from '@shrkcrft/core';
import { lexCodeZones, zoneAt } from '../extract/code-zones.ts';
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
   * as evaluated so their error is not swallowed.
   */
  readonly evaluated: number;
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
 * Whether the zone rule keeps a match at `index`. `all` keeps everything; the
 * narrower zones require the match to START in the named zone. Not applied to
 * inline-template units (their content is already a string body).
 */
function zoneKeeps(
  zone: PolicyScanZone,
  unit: IPolicyUnit,
  zones: ReturnType<typeof lexCodeZones> | undefined,
  index: number,
): boolean {
  if (zone === 'all' || unit.inlineTemplate || zones === undefined) return true;
  const kind = zoneAt(zones, index);
  if (zone === 'code') return kind === 'code';
  if (zone === 'strings') return kind === 'string';
  return kind === 'comment';
}

/**
 * Pure policy evaluation. Each rule's regex is run over the units the resolver
 * supplies; matches become findings (capture group 1 is the reported token when
 * present). Exemptions (`exemptFiles` / `exemptLines`) and the lexical `scan`
 * zone drop hits into {@link IPolicyReport.suppressed} rather than deleting
 * them, so `explain` can show what was matched AND what was let through. A
 * misconfigured rule (uncompilable regex) degrades to a diagnostic — never
 * throws, so one bad rule cannot crash the check.
 */
export function evaluatePolicy(rules: readonly IPolicyRule[], resolve: PolicyUnitResolver): IPolicyReport {
  const ruleResults: IPolicyRuleResult[] = [];
  const findings: IPolicyFinding[] = [];
  const suppressed: IPolicySuppression[] = [];
  const diagnostics: string[] = [];
  const skipped: IPolicySkip[] = [];
  let evaluated = 0;
  let misconfigError = false;
  let misconfigWarn = false;

  for (const rule of rules) {
    const severity: 'error' | 'warning' = rule.severity ?? 'error';
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
      });
      evaluated += 1;
      continue;
    }

    if (units.length === 0) {
      const failed = rule.failOnEmpty === true;
      skipped.push({
        ruleId: rule.id,
        reason: '0 content units matched the rule globs',
        failed,
        severity,
      });
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
    verdict: hasError ? 'errors' : hasWarn ? 'warnings' : 'pass',
  };
}
