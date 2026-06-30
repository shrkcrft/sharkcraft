import type { IPolicyRule, PolicySurface } from '@shrkcrft/core';
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

export interface IPolicyRuleResult {
  readonly ruleId: string;
  readonly surface: PolicySurface;
  readonly severity: 'error' | 'warning';
  readonly findingCount: number;
  readonly error?: string;
}

export interface IPolicyReport {
  readonly schema: typeof POLICY_LINT_SCHEMA;
  readonly rules: readonly IPolicyRuleResult[];
  readonly findings: readonly IPolicyFinding[];
  readonly diagnostics: readonly string[];
  /**
   * Count of rules that actually scanned ≥1 unit. A rule whose globs matched 0
   * files (e.g. a `style` rule in a project with no stylesheets) is NOT
   * evaluated — a silent no-op the gate surfaces as `skipped` rather than a
   * green pass. Misconfigured rules count as evaluated so their error is not
   * swallowed by the gate's `evaluated === 0` skip path.
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

/**
 * Pure policy evaluation. Each rule's regex is run over the units the resolver
 * supplies; matches become findings (capture group 1 is the reported token when
 * present). A misconfigured rule (uncompilable regex) degrades to a diagnostic
 * — never throws, so one bad rule cannot crash the check.
 */
export function evaluatePolicy(rules: readonly IPolicyRule[], resolve: PolicyUnitResolver): IPolicyReport {
  const ruleResults: IPolicyRuleResult[] = [];
  const findings: IPolicyFinding[] = [];
  const diagnostics: string[] = [];
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
      ruleResults.push({ ruleId: rule.id, surface: rule.surface, severity, findingCount: 0, error: msg });
      // A misconfigured rule attempted to run — count it as evaluated so its
      // error isn't swallowed by the gate's `evaluated === 0` skip path.
      evaluated += 1;
      continue;
    }

    const units = resolve(rule);
    if (units.length > 0) evaluated += 1;
    let count = 0;
    let zeroWidth = false;
    for (const unit of units) {
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
        const line = unit.baseLine - 1 + lineWithin(unit.content, m.index);
        findings.push({
          ruleId: rule.id,
          surface: rule.surface,
          file: unit.path,
          line,
          match: truncate(token),
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
      ruleResults.push({ ruleId: rule.id, surface: rule.surface, severity, findingCount: count, error: msg });
    } else {
      ruleResults.push({ ruleId: rule.id, surface: rule.surface, severity, findingCount: count });
    }
  }

  const hasError = misconfigError || findings.some((f) => f.severity === 'error');
  const hasWarn = misconfigWarn || findings.some((f) => f.severity === 'warning');
  return {
    schema: POLICY_LINT_SCHEMA,
    rules: ruleResults,
    findings,
    diagnostics,
    evaluated,
    verdict: hasError ? 'errors' : hasWarn ? 'warnings' : 'pass',
  };
}
