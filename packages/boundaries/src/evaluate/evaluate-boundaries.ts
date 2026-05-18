import type { IBoundaryRule, BoundarySeverity } from '../model/boundary-rule.ts';
import { matchesAny } from '../scan/glob.ts';
import type { IImportEdge, IImportScanResult } from '../scan/scan-imports.ts';
import {
  resolveAliasCandidates,
  type ITsconfigPathsMap,
} from '../scan/tsconfig-aliases.ts';

export interface IBoundaryViolation {
  ruleId: string;
  ruleTitle: string;
  severity: BoundarySeverity;
  file: string;
  importSpecifier: string;
  line: number;
  /** Pattern from `from` that matched the file. */
  matchedFrom: string;
  /** Pattern from `forbiddenImports` that matched the specifier, if any. */
  matchedForbidden?: string;
  /** When triggered by allowedImports = [..] (none matched). */
  notAllowed?: boolean;
  /** When the match came from an alias-resolved candidate path. */
  resolvedVia?: string;
  message: string;
  suggestedFix?: string;
}

export interface IEvaluateOptions {
  /** Optional filter: only evaluate rules with this id. */
  onlyRuleId?: string;
  /**
   * Optional tsconfig paths map. When supplied, every edge specifier is also
   * resolved against the alias map and the resulting candidate paths are
   * matched against rule patterns alongside the original specifier.
   */
  tsconfigPaths?: ITsconfigPathsMap;
}

export interface IEvaluateResult {
  rulesEvaluated: number;
  edgesEvaluated: number;
  violations: IBoundaryViolation[];
  /** Quick counts grouped by severity. */
  counts: { error: number; warning: number; info: number };
}

function severityOf(rule: IBoundaryRule): BoundarySeverity {
  return rule.severity ?? 'error';
}

/**
 * Evaluate every rule against every scanned edge. Returns the list of
 * violations + counts. Pure function — no I/O.
 */
export function evaluateBoundaries(
  scan: IImportScanResult,
  rules: readonly IBoundaryRule[],
  options: IEvaluateOptions = {},
): IEvaluateResult {
  const filtered = options.onlyRuleId
    ? rules.filter((r) => r.id === options.onlyRuleId)
    : rules;
  const violations: IBoundaryViolation[] = [];
  for (const rule of filtered) {
    for (const edge of scan.edges) {
      const matchedFrom = firstMatch(edge.from, rule.from);
      if (!matchedFrom) continue;
      // Build the candidate list: the literal specifier + any tsconfig
      // alias resolutions. The first match wins; resolved paths give the
      // boundary rule a chance to match against `libs/app/adapter/**`
      // even when the source code wrote `@app/adapter-core`.
      const specifiers: string[] = [edge.importSpecifier];
      if (options.tsconfigPaths) {
        for (const resolved of resolveAliasCandidates(edge.importSpecifier, options.tsconfigPaths)) {
          specifiers.push(resolved);
        }
      }

      // Forbidden imports — match any candidate.
      let matchedForbidden: string | undefined;
      let matchedVia: string | undefined;
      if (rule.forbiddenImports) {
        for (const spec of specifiers) {
          const m = firstMatch(spec, rule.forbiddenImports);
          if (m) {
            matchedForbidden = m;
            matchedVia = spec !== edge.importSpecifier ? spec : undefined;
            break;
          }
        }
      }
      if (matchedForbidden) {
        const v = violationFor(rule, edge, matchedFrom, matchedForbidden);
        if (matchedVia) v.resolvedVia = matchedVia;
        violations.push(v);
        continue;
      }

      // Allowed imports — when set, anything NOT matching (any candidate)
      // is a violation.
      if (rule.allowedImports && rule.allowedImports.length > 0) {
        const matchedAllowed = specifiers.some((s) => matchesAny(s, rule.allowedImports!));
        if (!matchedAllowed && !edge.importSpecifier.startsWith('.')) {
          violations.push({
            ...violationFor(rule, edge, matchedFrom, undefined),
            notAllowed: true,
          });
        }
      }
    }
  }
  const counts = { error: 0, warning: 0, info: 0 };
  for (const v of violations) counts[v.severity] += 1;
  return {
    rulesEvaluated: filtered.length,
    edgesEvaluated: scan.edges.length,
    violations,
    counts,
  };
}

function firstMatch(value: string, patterns: readonly string[]): string | undefined {
  for (const p of patterns) {
    if (matchesAny(value, [p])) return p;
  }
  return undefined;
}

function violationFor(
  rule: IBoundaryRule,
  edge: IImportEdge,
  matchedFrom: string,
  matchedForbidden: string | undefined,
): IBoundaryViolation {
  return {
    ruleId: rule.id,
    ruleTitle: rule.title,
    severity: severityOf(rule),
    file: edge.from,
    importSpecifier: edge.importSpecifier,
    line: edge.line,
    matchedFrom,
    ...(matchedForbidden ? { matchedForbidden } : {}),
    message:
      rule.message ??
      (matchedForbidden
        ? `Forbidden import in ${edge.from}: "${edge.importSpecifier}" matched "${matchedForbidden}"`
        : `Import "${edge.importSpecifier}" not in allowed list for ${rule.id}`),
    ...(rule.suggestedFix ? { suggestedFix: rule.suggestedFix } : {}),
  };
}
