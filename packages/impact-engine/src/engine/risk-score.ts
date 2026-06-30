import type { RiskLevel } from '../schema/impact-analysis.ts';

interface IRiskInputs {
  directCount: number;
  transitiveCount: number;
  packagesTouched: number;
  rulesTouched: number;
  templatesTouched: number;
  publicApiTouched: boolean;
  callerFilesCount: number;
}

/**
 * Deterministic, heuristic risk score. Weights chosen to match the
 * v2 inspector's qualitative behavior (small change → low, big graph
 * spread or public-API touch → high+) without depending on the
 * inspector's exact internal scoring.
 *
 * The thresholds are tuned for the SharkCraft monorepo and similar
 * mid-size TS workspaces. They will need re-tuning when applied to
 * very large or very small codebases — surface that as a future
 * configuration knob if needed.
 */
export function classifyRisk(input: IRiskInputs): { risk: RiskLevel; reasons: readonly string[] } {
  let score = 0;
  const reasons: string[] = [];
  if (input.directCount >= 5) {
    score += 2;
    reasons.push(`${input.directCount} direct dependents`);
  } else if (input.directCount > 0) {
    score += 1;
    reasons.push(`${input.directCount} direct dependents`);
  }
  if (input.transitiveCount >= 50) {
    score += 3;
    reasons.push(`${input.transitiveCount} transitive dependents`);
  } else if (input.transitiveCount >= 10) {
    score += 2;
    reasons.push(`${input.transitiveCount} transitive dependents`);
  }
  if (input.packagesTouched >= 5) {
    score += 2;
    reasons.push(`${input.packagesTouched} workspace packages spanned`);
  } else if (input.packagesTouched >= 2) {
    score += 1;
    reasons.push(`${input.packagesTouched} workspace packages spanned`);
  }
  if (input.rulesTouched > 0) {
    score += 1;
    reasons.push(`${input.rulesTouched} boundary rule(s) apply`);
  }
  if (input.templatesTouched > 0) {
    score += 1;
    reasons.push(`covered by ${input.templatesTouched} template(s) — verify drift`);
  }
  if (input.publicApiTouched) {
    score += 2;
    reasons.push('public API surface touched');
  }
  if (input.callerFilesCount >= 10) {
    score += 1;
    reasons.push(`${input.callerFilesCount} caller files`);
  }
  const risk: RiskLevel =
    score >= 8 ? 'critical' : score >= 5 ? 'high' : score >= 2 ? 'medium' : 'low';
  return { risk, reasons };
}

/** Re-export so callers can read the (partial) inputs back for tests. */
export type { IRiskInputs };
