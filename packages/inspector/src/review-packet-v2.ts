import { buildReviewPacket, type IBuildReviewPacketOptions, type IReviewPacket } from './review-packet.ts';
import { analyzeImpact, type IImpactAnalysis } from './impact-analysis.ts';
import { analyzeTestImpact, type ITestImpact } from './test-impact.ts';
import { buildAreaMap, type IAreaMap } from './area-map.ts';
import { impactFor, loadOwnershipRules, type IOwnershipImpact, type IOwnershipRule } from './ownership.ts';
import { evaluatePolicy, type IPolicyReport } from './policy-engine.ts';
import { compareQualityBaseline, type IQualityBaselineComparison } from './quality-baseline.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const REVIEW_PACKET_V2_SCHEMA = 'sharkcraft.review-packet-v2/v1';

export interface IReviewPacketV2 {
  schema: typeof REVIEW_PACKET_V2_SCHEMA;
  /** Original v1 packet (back-compat). */
  base: IReviewPacket;
  areaMap: IAreaMap;
  impact: IImpactAnalysis;
  testImpact: ITestImpact;
  ownership: IOwnershipImpact;
  policy: IPolicyReport;
  qualityComparison?: IQualityBaselineComparison;
  suggestedReviewers: readonly string[];
  riskScore: number;
}

export interface IBuildReviewPacketV2Options extends IBuildReviewPacketOptions {
  ownershipFiles?: readonly string[];
  /** Optional file path to a quality baseline json — when present compare it. */
  qualityBaselineFile?: string;
}

export async function buildReviewPacketV2(
  inspection: ISharkcraftInspection,
  options: IBuildReviewPacketV2Options = {},
): Promise<IReviewPacketV2> {
  const base = buildReviewPacket(inspection, options);
  const areaMap = buildAreaMap(inspection);
  const impact = await analyzeImpact(inspection, {
    files: base.changedFiles,
    areaMap,
  });
  const testImpact = analyzeTestImpact(inspection, { files: base.changedFiles });
  const { rules } = await loadOwnershipRules(inspection.projectRoot, options.ownershipFiles);
  const ownership = impactFor(base.changedFiles, rules);
  const policy = await evaluatePolicy(inspection);

  let qualityComparison: IQualityBaselineComparison | undefined;
  if (options.qualityBaselineFile) {
    const cmp = await compareQualityBaseline(inspection, options.qualityBaselineFile);
    if (cmp) qualityComparison = cmp;
  }

  const suggestedReviewers = mergeReviewers(rules, ownership);

  const riskScore = computeRiskScore({
    impactRisk: impact.risk,
    boundaryViolations: base.boundaryViolations.length,
    missingTests: base.missingTestsHeuristic.length,
    policyErrors: policy.summary.error + policy.summary.critical,
    qualityRegressions: qualityComparison?.regressions.length ?? 0,
  });

  const out: IReviewPacketV2 = {
    schema: REVIEW_PACKET_V2_SCHEMA,
    base,
    areaMap,
    impact,
    testImpact,
    ownership,
    policy,
    suggestedReviewers,
    riskScore,
  };
  if (qualityComparison) out.qualityComparison = qualityComparison;
  return out;
}

function mergeReviewers(rules: readonly IOwnershipRule[], impact: IOwnershipImpact): string[] {
  const out = new Set<string>(impact.reviewers);
  for (const r of rules) for (const rev of r.reviewers) out.add(rev);
  return [...out].sort();
}

function computeRiskScore(input: {
  impactRisk: string;
  boundaryViolations: number;
  missingTests: number;
  policyErrors: number;
  qualityRegressions: number;
}): number {
  let s = 0;
  if (input.impactRisk === 'critical') s += 60;
  else if (input.impactRisk === 'high') s += 40;
  else if (input.impactRisk === 'medium') s += 20;
  else s += 5;
  s += Math.min(20, input.boundaryViolations * 3);
  s += Math.min(15, input.missingTests * 1);
  s += Math.min(20, input.policyErrors * 5);
  s += Math.min(15, input.qualityRegressions * 3);
  return Math.min(100, s);
}
