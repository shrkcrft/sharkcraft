/**
 * Risk-signal aggregator.
 *
 * Centralised, deterministic source of risk inputs used by orchestration,
 * simulation, role views and the recommender. Read-only.
 */
import { buildArchitectureMap } from './architecture-map.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const RISK_SIGNALS_SCHEMA = 'sharkcraft.risk-signals/v1';

export enum RiskLevel {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  Critical = 'critical',
}

export interface IRiskSignals {
  schema: typeof RISK_SIGNALS_SCHEMA;
  generatedAt: string;
  level: RiskLevel;
  reasons: readonly string[];
  inputs: {
    boundaryViolationErrors: number;
    boundaryViolationWarnings: number;
    architectureRisks: number;
    hasPacks: boolean;
    packsUnsignedOrInvalid: number;
    testsDetected: number;
    ownershipDetected: number;
    fileListTruncated: boolean;
  };
}

export async function computeRiskSignals(
  inspection: ISharkcraftInspection,
  options: { withSignals?: boolean } = {},
): Promise<IRiskSignals> {
  const map = await buildArchitectureMap(inspection, { signals: options.withSignals ?? true });
  const validPacks = inspection.packs.validPacks ?? [];
  const packsUnsignedOrInvalid = validPacks.filter(
    (p) => p.signatureStatus === 'invalid-signature' || p.signatureStatus === 'missing-signature',
  ).length;
  const inputs = {
    boundaryViolationErrors: map.boundaryViolationCounts.error,
    boundaryViolationWarnings: map.boundaryViolationCounts.warning,
    architectureRisks: map.risks.length,
    hasPacks: validPacks.length > 0,
    packsUnsignedOrInvalid,
    testsDetected: map.graphSummary.tests,
    ownershipDetected: map.graphSummary.ownership,
    fileListTruncated: false,
  };
  const reasons: string[] = [];
  let score = 0;
  if (inputs.boundaryViolationErrors > 0) {
    score += 3;
    reasons.push(`${inputs.boundaryViolationErrors} boundary violation(s) at error severity.`);
  }
  if (inputs.boundaryViolationWarnings > 0) {
    score += 1;
    reasons.push(`${inputs.boundaryViolationWarnings} boundary violation(s) at warning severity.`);
  }
  if (inputs.architectureRisks > 0) {
    score += 1;
    reasons.push(`${inputs.architectureRisks} architecture risk finding(s).`);
  }
  if (inputs.packsUnsignedOrInvalid > 0) {
    score += 2;
    reasons.push(`${inputs.packsUnsignedOrInvalid} pack(s) with invalid/missing signature.`);
  }
  if (inputs.testsDetected === 0) {
    score += 2;
    reasons.push('No tests detected.');
  }
  let level: RiskLevel = RiskLevel.Low;
  if (score >= 5) level = RiskLevel.Critical;
  else if (score >= 3) level = RiskLevel.High;
  else if (score >= 1) level = RiskLevel.Medium;
  if (reasons.length === 0) reasons.push('No elevated risk signals detected.');
  return {
    schema: RISK_SIGNALS_SCHEMA,
    generatedAt: new Date().toISOString(),
    level,
    reasons,
    inputs,
  };
}
