import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { buildDriftReport, type IDriftFinding } from './drift.ts';

export const DRIFT_BASELINE_SCHEMA = 'sharkcraft.drift-baseline/v1';

export interface IDriftBaselineFinding {
  fingerprint: string;
  category: string;
  severity: string;
  message: string;
  ruleId?: string;
  file?: string;
}

export interface IDriftBaseline {
  schema: typeof DRIFT_BASELINE_SCHEMA;
  createdAt: string;
  projectRoot: string;
  findings: readonly IDriftBaselineFinding[];
}

export interface IDriftBaselineComparison {
  schema: 'sharkcraft.drift-baseline-comparison/v1';
  baselineFile: string;
  baseline: IDriftBaseline;
  current: IDriftBaseline;
  existing: readonly IDriftBaselineFinding[];
  newFindings: readonly IDriftBaselineFinding[];
  resolved: readonly IDriftBaselineFinding[];
}

function fingerprint(f: IDriftFinding): string {
  const ev = (f.evidence ?? {}) as { ruleId?: string; file?: string };
  return [
    f.category,
    f.severity,
    ev.ruleId ?? '',
    ev.file ?? '',
    f.message.slice(0, 80),
  ].join('|');
}

function toBaselineFinding(f: IDriftFinding): IDriftBaselineFinding {
  const ev = (f.evidence ?? {}) as { ruleId?: string; file?: string };
  const out: IDriftBaselineFinding = {
    fingerprint: fingerprint(f),
    category: f.category,
    severity: f.severity,
    message: f.message,
  };
  if (ev.ruleId) out.ruleId = ev.ruleId;
  if (ev.file) out.file = ev.file;
  return out;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createDriftBaseline(
  inspection: ISharkcraftInspection,
  outFile: string,
): IDriftBaseline {
  const drift = buildDriftReport(inspection);
  const findings = drift.findings.map(toBaselineFinding);
  const baseline: IDriftBaseline = {
    schema: DRIFT_BASELINE_SCHEMA,
    createdAt: nowIso(),
    // Store only the repo basename, not the absolute path — baselines are
    // committed to version control and absolute paths leak the author's
    // filesystem layout into the public repo.
    projectRoot: nodePath.basename(inspection.projectRoot),
    findings,
  };
  mkdirSync(nodePath.dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
  return baseline;
}

export function readDriftBaseline(file: string): IDriftBaseline | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as IDriftBaseline;
  } catch {
    return null;
  }
}

export function compareDriftBaseline(
  inspection: ISharkcraftInspection,
  baselineFile: string,
): IDriftBaselineComparison | null {
  const baseline = readDriftBaseline(baselineFile);
  if (!baseline) return null;
  const drift = buildDriftReport(inspection);
  const currentList = drift.findings.map(toBaselineFinding);
  const baselineSet = new Set(baseline.findings.map((f) => f.fingerprint));
  const currentSet = new Set(currentList.map((f) => f.fingerprint));
  const existing = currentList.filter((f) => baselineSet.has(f.fingerprint));
  const newFindings = currentList.filter((f) => !baselineSet.has(f.fingerprint));
  const resolved = baseline.findings.filter((f) => !currentSet.has(f.fingerprint));
  return {
    schema: 'sharkcraft.drift-baseline-comparison/v1',
    baselineFile,
    baseline,
    current: {
      schema: DRIFT_BASELINE_SCHEMA,
      createdAt: nowIso(),
      projectRoot: nodePath.basename(inspection.projectRoot),
      findings: currentList,
    },
    existing,
    newFindings,
    resolved,
  };
}
