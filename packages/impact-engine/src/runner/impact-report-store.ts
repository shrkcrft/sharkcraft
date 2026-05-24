import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IGraphImpactAnalysis } from '../schema/impact-analysis.ts';

export const IMPACT_RUN_SCHEMA = 'sharkcraft.impact-run/v1' as const;
const REPORT_REL = '.sharkcraft/impact/last.json';
const BASELINE_REL = '.sharkcraft/impact/baseline.json';

/**
 * Compact, doctor-friendly snapshot of the most recent `shrk impact`
 * run. The full v3 payload can carry hundreds of `IAffectedNodeRef`
 * entries — we keep counts + a representative `inputSummary` so the
 * dashboard / doctor can answer "what was the last analysis" without
 * loading every dependent.
 */
export interface IImpactRunReport {
  schema: typeof IMPACT_RUN_SCHEMA;
  generatedAt: string;
  inputKind: 'files' | 'symbol' | 'gitref';
  /** Short, human-readable summary of the request (file list, ref, …). */
  inputSummary: string;
  risk: 'low' | 'medium' | 'high' | 'critical';
  directDependentCount: number;
  transitiveDependentCount: number;
  affectedPackageCount: number;
  affectedSymbolCount: number;
  affectedCallerFileCount: number;
  affectedRuleCount: number;
  affectedTemplateCount: number;
  likelyTestCount: number;
  publicApiTouched: boolean;
  riskReasons: readonly string[];
  validationScope: readonly string[];
  diagnostics: readonly string[];
}

export class ImpactReportStore {
  public readonly absPath: string;
  public readonly baselinePath: string;

  constructor(private readonly projectRoot: string) {
    this.absPath = nodePath.join(projectRoot, REPORT_REL);
    this.baselinePath = nodePath.join(projectRoot, BASELINE_REL);
  }

  exists(): boolean {
    return existsSync(this.absPath);
  }

  baselineExists(): boolean {
    return existsSync(this.baselinePath);
  }

  read(): IImpactRunReport | undefined {
    if (!this.exists()) return undefined;
    try {
      const raw = JSON.parse(readFileSync(this.absPath, 'utf8')) as IImpactRunReport;
      if (raw.schema !== IMPACT_RUN_SCHEMA) return undefined;
      return raw;
    } catch {
      return undefined;
    }
  }

  write(report: IImpactRunReport): void {
    mkdirSync(nodePath.dirname(this.absPath), { recursive: true });
    writeFileSync(this.absPath, JSON.stringify(report, null, 2), 'utf8');
  }

  readBaseline(): IImpactRunReport | undefined {
    if (!this.baselineExists()) return undefined;
    try {
      const raw = JSON.parse(readFileSync(this.baselinePath, 'utf8')) as IImpactRunReport;
      if (raw.schema !== IMPACT_RUN_SCHEMA) return undefined;
      return raw;
    } catch {
      return undefined;
    }
  }

  writeBaseline(report: IImpactRunReport): void {
    mkdirSync(nodePath.dirname(this.baselinePath), { recursive: true });
    writeFileSync(this.baselinePath, JSON.stringify(report, null, 2), 'utf8');
  }

  clearBaseline(): boolean {
    if (!this.baselineExists()) return false;
    rmSync(this.baselinePath);
    return true;
  }
}

export interface IImpactDelta {
  /** last.dependents (direct + transitive) − baseline.dependents. */
  dependentDelta: number;
  /** last.packageCount − baseline.packageCount. */
  packageDelta: number;
  /** Risk drift summary, e.g. "low → high". */
  riskDrift?: string;
  /** Is `last` strictly worse than baseline along any axis? */
  worsened: boolean;
}

export function diffImpactReports(
  baseline: IImpactRunReport,
  last: IImpactRunReport,
): IImpactDelta {
  const baseDeps = baseline.directDependentCount + baseline.transitiveDependentCount;
  const lastDeps = last.directDependentCount + last.transitiveDependentCount;
  const baseRiskIdx = riskRank(baseline.risk);
  const lastRiskIdx = riskRank(last.risk);
  const riskWorsened = lastRiskIdx > baseRiskIdx;
  const dependentWorsened = lastDeps > baseDeps;
  const packageWorsened = last.affectedPackageCount > baseline.affectedPackageCount;
  return {
    dependentDelta: lastDeps - baseDeps,
    packageDelta: last.affectedPackageCount - baseline.affectedPackageCount,
    ...(baseline.risk !== last.risk ? { riskDrift: `${baseline.risk} → ${last.risk}` } : {}),
    worsened: riskWorsened || dependentWorsened || packageWorsened,
  };
}

function riskRank(r: IImpactRunReport['risk']): number {
  switch (r) {
    case 'low':
      return 0;
    case 'medium':
      return 1;
    case 'high':
      return 2;
    case 'critical':
      return 3;
  }
}

/**
 * Build a compact `IImpactRunReport` from the full v3 payload + the
 * request summary string. Pure; callers persist via `ImpactReportStore`.
 */
export function snapshotImpactAnalysis(
  analysis: IGraphImpactAnalysis,
  inputSummary: string,
): IImpactRunReport {
  return {
    schema: IMPACT_RUN_SCHEMA,
    generatedAt: new Date().toISOString(),
    inputKind: analysis.inputKind,
    inputSummary,
    risk: analysis.risk,
    directDependentCount: analysis.directDependents.length,
    transitiveDependentCount: analysis.transitiveDependents.length,
    affectedPackageCount: analysis.affectedPackages.length,
    affectedSymbolCount: analysis.affectedSymbols.length,
    affectedCallerFileCount: analysis.affectedCallerFiles.length,
    affectedRuleCount: analysis.affectedRules.length,
    affectedTemplateCount: analysis.affectedTemplates.length,
    likelyTestCount: analysis.likelyTests.length,
    publicApiTouched: analysis.publicApiTouched,
    riskReasons: [...analysis.riskReasons],
    validationScope: [...analysis.validationScope],
    diagnostics: [...analysis.diagnostics],
  };
}
