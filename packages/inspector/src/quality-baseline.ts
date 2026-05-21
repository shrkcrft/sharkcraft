import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import * as nodePath from 'node:path';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { buildAiReadinessReport } from './ai-readiness.ts';
import { buildCoverageReport } from './coverage-report.ts';
import { buildQualityReport, type IQualityReport } from './quality-report.ts';

export const QUALITY_BASELINE_SCHEMA = 'sharkcraft.quality-baseline/v1';

export interface IQualityBaselineGate {
  id: string;
  passed: boolean;
  errors: number;
  warnings: number;
}

export interface IQualityBaselineCategoryScore {
  id: string;
  score: number;
  /** raw category data so consumers can dig deeper. */
  data?: Record<string, unknown>;
}

export interface IQualityBaselinePackSignaturesSummary {
  total: number;
  verified: number;
  unverified: number;
  invalid: number;
  notChecked: number;
}

export interface IQualityBaseline {
  schema: typeof QUALITY_BASELINE_SCHEMA;
  createdAt: string;
  projectRoot: string;
  /** SharkCraft toolkit version that produced this baseline. */
  sharkcraftVersion: string;
  /** Optional hash of sharkcraft.config.ts content; null when no config file. */
  configHash: string | null;
  qualityScore: number;
  readinessScore: number;
  blockers: number;
  warnings: number;
  /** Per-gate pass/fail snapshot. */
  gates: readonly IQualityBaselineGate[];
  /** Coverage / readiness categories. */
  categoryScores: readonly IQualityBaselineCategoryScore[];
  driftFindings: number;
  driftErrors: number;
  driftWarnings: number;
  packSignatures: IQualityBaselinePackSignaturesSummary;
}

export interface IQualityBaselineDelta {
  metric: string;
  baseline: number;
  current: number;
  delta: number;
  direction: 'improved' | 'regressed' | 'unchanged';
}

export interface IQualityBaselineComparison {
  schema: 'sharkcraft.quality-baseline-comparison/v1';
  baselineFile: string;
  baseline: IQualityBaseline;
  current: IQualityBaseline;
  deltas: readonly IQualityBaselineDelta[];
  regressions: readonly IQualityBaselineDelta[];
  improvements: readonly IQualityBaselineDelta[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function gateNumeric(gate: { data?: Record<string, unknown> }, key: string): number {
  const v = gate.data?.[key];
  return typeof v === 'number' ? v : 0;
}

function readSharkcraftVersion(projectRoot: string): string {
  // Best-effort: look for the toolkit's own package.json next to the inspector.
  // Falls back to '0.0.0' rather than throwing if discovery fails.
  const candidates = [
    nodePath.join(projectRoot, 'package.json'),
  ];
  try {
    // Walk up from this file to find packages/inspector/package.json.
    const here = new URL('.', import.meta.url).pathname;
    const insp = nodePath.resolve(here, '..', 'package.json');
    candidates.unshift(insp);
  } catch {
    /* ignore */
  }
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const v = JSON.parse(readFileSync(p, 'utf8')) as { version?: string; name?: string };
      if (v.version) return v.version;
    } catch {
      /* ignore */
    }
  }
  return '0.0.0';
}

function configHashFor(inspection: ISharkcraftInspection): string | null {
  const file = inspection.configFile;
  if (!file || !existsSync(file)) return null;
  try {
    const content = readFileSync(file, 'utf8');
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

function packSignaturesSummary(
  inspection: ISharkcraftInspection,
): IQualityBaselinePackSignaturesSummary {
  const summary: IQualityBaselinePackSignaturesSummary = {
    total: 0,
    verified: 0,
    unverified: 0,
    invalid: 0,
    notChecked: 0,
  };
  for (const pack of inspection.packs.validPacks ?? []) {
    summary.total += 1;
    const status = (pack as { signatureStatus?: string }).signatureStatus;
    if (status === 'verified') summary.verified += 1;
    else if (status === 'invalid-signature') summary.invalid += 1;
    else if (status === 'not-checked' || !status) summary.notChecked += 1;
    else summary.unverified += 1;
  }
  return summary;
}

function categoryScoresFrom(inspection: ISharkcraftInspection): IQualityBaselineCategoryScore[] {
  const out: IQualityBaselineCategoryScore[] = [];
  try {
    const cov = buildCoverageReport(inspection);
    for (const c of cov.categories) {
      out.push({ id: `coverage:${c.id}`, score: c.score });
    }
    out.push({ id: 'coverage:overall', score: cov.overall });
  } catch {
    /* ignore */
  }
  try {
    const r = buildAiReadinessReport(inspection);
    out.push({ id: 'readiness:overall', score: r.score });
  } catch {
    /* ignore */
  }
  return out;
}

function extractBaseline(
  inspection: ISharkcraftInspection,
  report: IQualityReport,
): IQualityBaseline {
  const drift = report.drift;
  const readiness = (() => {
    try {
      return buildAiReadinessReport(inspection).score;
    } catch {
      return 0;
    }
  })();
  return {
    schema: QUALITY_BASELINE_SCHEMA,
    createdAt: nowIso(),
    // Repo basename only — baselines are committed and absolute paths
    // leak the author's filesystem layout into the public repo.
    projectRoot: nodePath.basename(inspection.projectRoot),
    sharkcraftVersion: readSharkcraftVersion(inspection.projectRoot),
    configHash: configHashFor(inspection),
    qualityScore: report.score,
    readinessScore: readiness,
    blockers: report.blockers,
    warnings: report.warnings,
    gates: report.gates.map((g) => ({
      id: g.id,
      passed: g.passed,
      errors: gateNumeric(g, 'errors'),
      warnings: gateNumeric(g, 'warnings'),
    })),
    categoryScores: categoryScoresFrom(inspection),
    driftFindings: drift?.findings.length ?? 0,
    driftErrors: drift?.counts.error ?? 0,
    driftWarnings: drift?.counts.warning ?? 0,
    packSignatures: packSignaturesSummary(inspection),
  };
}

export async function createQualityBaseline(
  inspection: ISharkcraftInspection,
  outFile: string,
): Promise<IQualityBaseline> {
  const report = await buildQualityReport({
    inspection,
    config: {},
  });
  const baseline = extractBaseline(inspection, report);
  mkdirSync(nodePath.dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
  return baseline;
}

export function readQualityBaseline(file: string): IQualityBaseline | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as IQualityBaseline;
  } catch {
    return null;
  }
}

export interface IQualityBaselineFileDiff {
  schema: 'sharkcraft.quality-baseline-diff/v1';
  oldFile: string;
  newFile: string;
  oldBaseline: IQualityBaseline;
  newBaseline: IQualityBaseline;
  scoreDelta: number;
  blockersDelta: number;
  warningsDelta: number;
  categoryDeltas: readonly { id: string; old: number; new: number; delta: number }[];
  resolvedWarnings: readonly string[];
  newWarnings: readonly string[];
  signatureChanges: {
    addedVerified: number;
    lostVerified: number;
  };
  configHashChanged: boolean;
}

export function diffQualityBaselineFiles(
  oldFile: string,
  newFile: string,
): IQualityBaselineFileDiff | null {
  const oldBaseline = readQualityBaseline(oldFile);
  const newBaseline = readQualityBaseline(newFile);
  if (!oldBaseline || !newBaseline) return null;
  const categoryDeltas: { id: string; old: number; new: number; delta: number }[] = [];
  const newCats = new Map((newBaseline.categoryScores ?? []).map((c) => [c.id, c.score]));
  for (const oldCat of oldBaseline.categoryScores ?? []) {
    const cur = newCats.get(oldCat.id) ?? 0;
    if (cur === oldCat.score) continue;
    categoryDeltas.push({ id: oldCat.id, old: oldCat.score, new: cur, delta: cur - oldCat.score });
  }
  // Per-gate warning movement: gates that flipped passed→failed produce "new warnings".
  const oldGates = new Map(oldBaseline.gates.map((g) => [g.id, g]));
  const newWarnings: string[] = [];
  const resolvedWarnings: string[] = [];
  for (const g of newBaseline.gates) {
    const b = oldGates.get(g.id);
    if (!b) continue;
    if (b.passed && !g.passed) newWarnings.push(`gate ${g.id} now failing`);
    if (!b.passed && g.passed) resolvedWarnings.push(`gate ${g.id} now passing`);
    if (g.warnings > b.warnings) newWarnings.push(`gate ${g.id} warnings +${g.warnings - b.warnings}`);
    if (g.warnings < b.warnings) resolvedWarnings.push(`gate ${g.id} warnings -${b.warnings - g.warnings}`);
  }
  return {
    schema: 'sharkcraft.quality-baseline-diff/v1',
    oldFile,
    newFile,
    oldBaseline,
    newBaseline,
    scoreDelta: newBaseline.qualityScore - oldBaseline.qualityScore,
    blockersDelta: newBaseline.blockers - oldBaseline.blockers,
    warningsDelta: newBaseline.warnings - oldBaseline.warnings,
    categoryDeltas,
    resolvedWarnings,
    newWarnings,
    signatureChanges: {
      addedVerified:
        Math.max(0, newBaseline.packSignatures.verified - oldBaseline.packSignatures.verified),
      lostVerified:
        Math.max(0, oldBaseline.packSignatures.verified - newBaseline.packSignatures.verified),
    },
    configHashChanged: oldBaseline.configHash !== newBaseline.configHash,
  };
}

export interface IQualityBaselinePruneInput {
  cwd: string;
  /** Directory containing historical baselines. Defaults to `.sharkcraft/baselines/`. */
  baselineDir?: string;
  /** Keep the last N baselines. Default: 10. */
  keep?: number;
  /** When true, actually delete files; otherwise dry-run. */
  write?: boolean;
}

export interface IQualityBaselinePruneResult {
  schema: 'sharkcraft.quality-baseline-prune/v1';
  baselineDir: string;
  kept: readonly string[];
  pruned: readonly string[];
  dryRun: boolean;
}

export interface IQualityBaselineHistoryEntry {
  file: string;
  createdAt: string;
  qualityScore: number;
  readinessScore: number;
  blockers: number;
  warnings: number;
  configHash: string | null;
  signaturesVerified: number;
  signaturesTotal: number;
}

export interface IQualityBaselineHistory {
  schema: 'sharkcraft.quality-baseline-history/v1';
  baselineDir: string;
  entries: readonly IQualityBaselineHistoryEntry[];
  latest: IQualityBaselineHistoryEntry | null;
  previous: IQualityBaselineHistoryEntry | null;
}

export function listQualityBaselineHistory(
  cwd: string,
  baselineDir?: string,
): IQualityBaselineHistory {
  const dir = baselineDir ?? nodePath.join(cwd, '.sharkcraft', 'baselines');
  const entries: IQualityBaselineHistoryEntry[] = [];
  if (existsSync(dir)) {
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        const full = nodePath.join(dir, f);
        try {
          if (!statSync(full).isFile()) continue;
        } catch {
          continue;
        }
        const b = readQualityBaseline(full);
        if (!b) continue;
        entries.push({
          file: full,
          createdAt: b.createdAt,
          qualityScore: b.qualityScore,
          readinessScore: b.readinessScore,
          blockers: b.blockers,
          warnings: b.warnings,
          configHash: b.configHash ?? null,
          signaturesVerified: b.packSignatures?.verified ?? 0,
          signaturesTotal: b.packSignatures?.total ?? 0,
        });
      }
    } catch {
      /* ignore */
    }
  }
  // Sort newest first by createdAt.
  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    schema: 'sharkcraft.quality-baseline-history/v1',
    baselineDir: dir,
    entries,
    latest: entries[0] ?? null,
    previous: entries[1] ?? null,
  };
}

export function pruneQualityBaselines(
  input: IQualityBaselinePruneInput,
): IQualityBaselinePruneResult {
  const dir =
    input.baselineDir ?? nodePath.join(input.cwd, '.sharkcraft', 'baselines');
  const keep = Math.max(1, input.keep ?? 10);
  if (!existsSync(dir)) {
    return {
      schema: 'sharkcraft.quality-baseline-prune/v1',
      baselineDir: dir,
      kept: [],
      pruned: [],
      dryRun: !input.write,
    };
  }
  const files: string[] = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const full = nodePath.join(dir, f);
      try {
        if (!statSync(full).isFile()) continue;
      } catch {
        continue;
      }
      files.push(full);
    }
  } catch {
    /* ignore */
  }
  // Sort by createdAt inside each baseline (descending). Fallback: filename.
  files.sort((a, b) => {
    const ba = readQualityBaseline(a)?.createdAt ?? a;
    const bb = readQualityBaseline(b)?.createdAt ?? b;
    return bb.localeCompare(ba);
  });
  const kept = files.slice(0, keep);
  const pruned = files.slice(keep);
  if (input.write) {
    for (const f of pruned) {
      try {
        unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  }
  return {
    schema: 'sharkcraft.quality-baseline-prune/v1',
    baselineDir: dir,
    kept,
    pruned,
    dryRun: !input.write,
  };
}

const HIGHER_IS_BETTER = new Set<string>(['qualityScore', 'readinessScore']);
const LOWER_IS_BETTER = new Set<string>([
  'blockers',
  'warnings',
  'driftFindings',
  'driftErrors',
  'driftWarnings',
]);

function classify(metric: string, delta: number): 'improved' | 'regressed' | 'unchanged' {
  if (delta === 0) return 'unchanged';
  if (HIGHER_IS_BETTER.has(metric)) return delta > 0 ? 'improved' : 'regressed';
  if (LOWER_IS_BETTER.has(metric)) return delta < 0 ? 'improved' : 'regressed';
  return 'unchanged';
}

export async function compareQualityBaseline(
  inspection: ISharkcraftInspection,
  baselineFile: string,
): Promise<IQualityBaselineComparison | null> {
  const baseline = readQualityBaseline(baselineFile);
  if (!baseline) return null;
  const report = await buildQualityReport({ inspection, config: {} });
  const current = extractBaseline(inspection, report);
  const deltas: IQualityBaselineDelta[] = [];
  const scalarMetrics = [
    'qualityScore',
    'readinessScore',
    'blockers',
    'warnings',
    'driftFindings',
    'driftErrors',
    'driftWarnings',
  ] as const;
  for (const metric of scalarMetrics) {
    const b = baseline[metric] as number;
    const c = current[metric] as number;
    const delta = c - b;
    deltas.push({
      metric,
      baseline: b,
      current: c,
      delta,
      direction: classify(metric, delta),
    });
  }
  // Gate-level deltas (passes only).
  const baselineGates = new Map(baseline.gates.map((g) => [g.id, g] as const));
  for (const g of current.gates) {
    const b = baselineGates.get(g.id);
    if (!b) continue;
    if (b.passed === g.passed) continue;
    deltas.push({
      metric: `gate:${g.id}`,
      baseline: b.passed ? 1 : 0,
      current: g.passed ? 1 : 0,
      delta: (g.passed ? 1 : 0) - (b.passed ? 1 : 0),
      direction: g.passed ? 'improved' : 'regressed',
    });
  }
  // Category score deltas.
  const baselineCats = new Map(
    (baseline.categoryScores ?? []).map((c) => [c.id, c] as const),
  );
  for (const c of current.categoryScores ?? []) {
    const b = baselineCats.get(c.id);
    if (!b) continue;
    const delta = c.score - b.score;
    if (delta === 0) continue;
    deltas.push({
      metric: `category:${c.id}`,
      baseline: b.score,
      current: c.score,
      delta,
      // Category scores are always "higher is better".
      direction: delta > 0 ? 'improved' : 'regressed',
    });
  }
  return {
    schema: 'sharkcraft.quality-baseline-comparison/v1',
    baselineFile,
    baseline,
    current,
    deltas,
    regressions: deltas.filter((d) => d.direction === 'regressed'),
    improvements: deltas.filter((d) => d.direction === 'improved'),
  };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderQualityBaselineHtml(
  baseline: IQualityBaseline,
  comparison?: IQualityBaselineComparison,
): string {
  const parts: string[] = [];
  parts.push('<!doctype html><html><head><meta charset="utf-8">');
  parts.push('<title>SharkCraft quality baseline</title>');
  parts.push('<style>body{font:14px/1.4 -apple-system,sans-serif;max-width:980px;margin:24px auto;padding:0 16px;color:#1f2328}');
  parts.push('h1{font-size:20px;border-bottom:1px solid #d0d7de;padding-bottom:8px}h2{font-size:16px;margin-top:24px}');
  parts.push('table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left}th{background:#f6f8fa}');
  parts.push('.tag{display:inline-block;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600}');
  parts.push('.tag.improved{background:#dafbe1;color:#1a7f37}.tag.regressed{background:#ffebe9;color:#cf222e}.tag.unchanged{background:#eaeef2;color:#57606a}');
  parts.push('</style></head><body>');
  parts.push('<h1>SharkCraft quality baseline</h1>');
  parts.push(`<p><strong>Captured:</strong> ${esc(baseline.createdAt)}<br>`);
  parts.push(`<strong>Toolkit version:</strong> ${esc(baseline.sharkcraftVersion)} ·`);
  parts.push(`<strong>Config hash:</strong> <code>${esc(baseline.configHash ?? '(none)')}</code></p>`);
  parts.push('<h2>Headline metrics</h2><table><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody>');
  parts.push(`<tr><td>Quality score</td><td>${baseline.qualityScore}</td></tr>`);
  parts.push(`<tr><td>Readiness score</td><td>${baseline.readinessScore}</td></tr>`);
  parts.push(`<tr><td>Blockers</td><td>${baseline.blockers}</td></tr>`);
  parts.push(`<tr><td>Warnings</td><td>${baseline.warnings}</td></tr>`);
  parts.push(`<tr><td>Drift findings</td><td>${baseline.driftFindings}</td></tr>`);
  parts.push(`<tr><td>Pack signatures</td><td>${baseline.packSignatures.verified}/${baseline.packSignatures.total} verified</td></tr>`);
  parts.push('</tbody></table>');
  parts.push('<h2>Category scores</h2><table><thead><tr><th>Category</th><th>Score</th></tr></thead><tbody>');
  for (const c of baseline.categoryScores) {
    parts.push(`<tr><td>${esc(c.id)}</td><td>${c.score}</td></tr>`);
  }
  parts.push('</tbody></table>');
  if (comparison) {
    parts.push('<h2>Comparison</h2><table><thead><tr><th>Metric</th><th>Baseline</th><th>Current</th><th>Δ</th><th>Direction</th></tr></thead><tbody>');
    for (const d of comparison.deltas) {
      parts.push(
        `<tr><td>${esc(d.metric)}</td><td>${d.baseline}</td><td>${d.current}</td><td>${d.delta}</td><td><span class="tag ${d.direction}">${d.direction}</span></td></tr>`,
      );
    }
    parts.push('</tbody></table>');
  }
  parts.push('<p><em>Generated by SharkCraft quality baseline v2.</em></p>');
  parts.push('</body></html>');
  return parts.join('\n') + '\n';
}
