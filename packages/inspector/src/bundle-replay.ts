import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  getBundleDir,
  listFeatureBundles,
  readFeatureBundle,
  type IFeatureBundle,
} from './feature-bundle.ts';

export const BUNDLE_REPLAY_SCHEMA = 'sharkcraft.bundle-replay/v1';

export enum BundleReplayStatus {
  Clean = 'clean',
  Warnings = 'warnings',
  Tampered = 'tampered',
  Missing = 'missing',
}

export interface IBundleReplayPlanEntry {
  planName: string;
  applied: boolean;
  /** Hash of the plan file at the time of replay. */
  currentHash: string | null;
  /** Hash recorded in the audit log, when available. */
  recordedHash?: string;
  /** Expected targets at replay time. */
  expectedTargets: readonly string[];
  /** Recorded targets if the audit captured them. */
  recordedTargets?: readonly string[];
  /** Issues detected for this plan. */
  issues: readonly string[];
}

export interface IBundleReplayWarning {
  code: string;
  message: string;
  planName?: string;
}

export interface IBundleReplay {
  schema: typeof BUNDLE_REPLAY_SCHEMA;
  bundleId: string;
  status: BundleReplayStatus;
  generatedAt: string;
  auditEntries: number;
  planEntries: readonly IBundleReplayPlanEntry[];
  warnings: readonly IBundleReplayWarning[];
  recommendedFix: string | null;
}

interface IAuditEntry {
  timestamp: string;
  action: string;
  planName: string;
  note?: string;
  raw: string;
}

function parseAuditLog(content: string): IAuditEntry[] {
  const out: IAuditEntry[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    // Expected shape: "<iso>  applied  <plan>[  note]"
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const timestamp = parts[0]!;
    const action = parts[1]!;
    const planName = parts[2]!;
    const note = parts.slice(3).join(' ').trim();
    out.push({ timestamp, action, planName, raw: line, ...(note ? { note } : {}) });
  }
  return out;
}

function hashOf(file: string): string | null {
  try {
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, 'utf8');
    return createHash('sha256').update(raw).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

function extractPlanTargets(file: string): readonly string[] {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as {
      changes?: readonly { relativePath?: string }[];
      plan?: { changes?: readonly { relativePath?: string }[] };
    };
    const changes = data.changes ?? data.plan?.changes ?? [];
    return changes.map((c) => c.relativePath).filter((p): p is string => Boolean(p));
  } catch {
    return [];
  }
}

export function replayBundle(
  cwd: string,
  bundleId: string,
  options: { strict?: boolean } = {},
): IBundleReplay {
  const generatedAt = new Date().toISOString();
  const bundle = readFeatureBundle(cwd, bundleId);
  if (!bundle) {
    return {
      schema: BUNDLE_REPLAY_SCHEMA,
      bundleId,
      status: BundleReplayStatus.Missing,
      generatedAt,
      auditEntries: 0,
      planEntries: [],
      warnings: [
        { code: 'bundle-not-found', message: `Bundle "${bundleId}" not found.` },
      ],
      recommendedFix: `Run \`shrk bundle list\` to confirm the id.`,
    };
  }
  const dir = getBundleDir(cwd, bundleId);
  const auditFile = nodePath.join(dir, 'reports', 'apply-audit.log');
  const auditEntries: IAuditEntry[] = existsSync(auditFile)
    ? parseAuditLog(readFileSync(auditFile, 'utf8'))
    : [];

  const warnings: IBundleReplayWarning[] = [];
  const planEntries: IBundleReplayPlanEntry[] = [];
  const auditByPlan = new Map<string, IAuditEntry[]>();
  for (const e of auditEntries) {
    const arr = auditByPlan.get(e.planName) ?? [];
    arr.push(e);
    auditByPlan.set(e.planName, arr);
  }
  // For every plan in the bundle, check on-disk state vs audit.
  for (const plan of bundle.plans) {
    const planFile = nodePath.join(dir, 'plans', plan.file);
    const currentHash = hashOf(planFile);
    const targets = extractPlanTargets(planFile);
    const issues: string[] = [];
    const applied = plan.status === 'applied';
    const auditForPlan = auditByPlan.get(plan.name) ?? [];

    if (!existsSync(planFile) && plan.status !== 'intent') {
      issues.push('plan file missing on disk');
    }
    if (applied && auditForPlan.length === 0) {
      issues.push('plan marked applied but audit log has no entry');
    }
    if (!applied && auditForPlan.length > 0) {
      issues.push('audit log has apply entry but plan not marked applied');
    }
    if (
      plan.expectedTargets.length > 0 &&
      targets.length > 0 &&
      JSON.stringify([...plan.expectedTargets].sort()) !== JSON.stringify([...targets].sort())
    ) {
      issues.push('expectedTargets diverge from plan-file targets');
    }
    if (auditForPlan.length > 1) {
      warnings.push({
        code: 'multiple-apply-entries',
        message: `plan ${plan.name} has ${auditForPlan.length} audit entries.`,
        planName: plan.name,
      });
    }
    const entry: IBundleReplayPlanEntry = {
      planName: plan.name,
      applied,
      currentHash,
      expectedTargets: plan.expectedTargets,
      issues,
    };
    planEntries.push(entry);
  }

  // Audit entries referencing plans missing from the bundle.
  for (const [planName, entries] of auditByPlan) {
    if (bundle.plans.some((p) => p.name === planName)) continue;
    warnings.push({
      code: 'audit-orphan',
      message: `audit log mentions plan "${planName}" not present in bundle.json (${entries.length} entries).`,
      planName,
    });
  }

  // Validation-after-apply check: applied plans without any subsequent validation.
  const appliedCount = bundle.plans.filter((p) => p.status === 'applied').length;
  if (appliedCount > 0 && bundle.validations.length === 0) {
    warnings.push({
      code: 'no-validation-after-apply',
      message: 'plans applied but no validation entries recorded.',
    });
  }

  // Detect out-of-order apply against persisted dependencies.
  const applyOrder = auditEntries.map((e) => e.planName).filter((n) => n !== '');
  if (applyOrder.length > 1 && bundle.dependencies.length > 0) {
    const orderedSet = new Set<string>();
    for (const n of applyOrder) {
      const incoming = bundle.dependencies.filter((e) => e.to === n);
      for (const d of incoming) {
        if (!orderedSet.has(d.from)) {
          warnings.push({
            code: 'out-of-order-apply',
            message: `plan "${n}" applied before its dependency "${d.from}".`,
            planName: n,
          });
        }
      }
      orderedSet.add(n);
    }
  }

  let status = BundleReplayStatus.Clean;
  const hasIssues = planEntries.some((p) => p.issues.length > 0);
  if (hasIssues || warnings.some((w) => w.code === 'audit-orphan' || w.code === 'out-of-order-apply')) {
    status = BundleReplayStatus.Tampered;
  } else if (warnings.length > 0) {
    status = BundleReplayStatus.Warnings;
  }
  if (options.strict && warnings.length > 0) status = BundleReplayStatus.Tampered;

  const recommendedFix = buildRecommendedFix(bundle, status, warnings, planEntries);

  return {
    schema: BUNDLE_REPLAY_SCHEMA,
    bundleId,
    status,
    generatedAt,
    auditEntries: auditEntries.length,
    planEntries,
    warnings,
    recommendedFix,
  };
}

export const BUNDLE_REPLAY_BATCH_SCHEMA = 'sharkcraft.bundle-replay-batch/v1';

export interface IBundleReplayBatch {
  schema: typeof BUNDLE_REPLAY_BATCH_SCHEMA;
  generatedAt: string;
  total: number;
  cleanCount: number;
  warningsCount: number;
  tamperedCount: number;
  missingCount: number;
  reports: readonly IBundleReplay[];
  /** Up to 10 most serious issues across all bundles. */
  topIssues: readonly { bundleId: string; planName?: string; code: string; message: string }[];
}

export interface IBundleReplayAllOptions {
  strict?: boolean;
  /**
   * When set, only bundles whose id contains this substring (case-insensitive)
   * are included. Useful as a poor-man's --since filter.
   */
  match?: string;
}

export function replayAllBundles(
  cwd: string,
  options: IBundleReplayAllOptions = {},
): IBundleReplayBatch {
  const bundles = listFeatureBundles(cwd);
  const reports: IBundleReplay[] = [];
  for (const b of bundles) {
    if (options.match && !b.id.toLowerCase().includes(options.match.toLowerCase())) continue;
    reports.push(replayBundle(cwd, b.id, { strict: Boolean(options.strict) }));
  }
  const counts = {
    clean: 0,
    warnings: 0,
    tampered: 0,
    missing: 0,
  };
  const issues: { bundleId: string; planName?: string; code: string; message: string }[] = [];
  for (const r of reports) {
    if (r.status === BundleReplayStatus.Clean) counts.clean += 1;
    else if (r.status === BundleReplayStatus.Warnings) counts.warnings += 1;
    else if (r.status === BundleReplayStatus.Tampered) counts.tampered += 1;
    else counts.missing += 1;
    for (const p of r.planEntries) {
      for (const issue of p.issues) {
        issues.push({
          bundleId: r.bundleId,
          planName: p.planName,
          code: 'plan-issue',
          message: issue,
        });
      }
    }
    for (const w of r.warnings) {
      const entry: { bundleId: string; planName?: string; code: string; message: string } = {
        bundleId: r.bundleId,
        code: w.code,
        message: w.message,
      };
      if (w.planName) entry.planName = w.planName;
      issues.push(entry);
    }
  }
  return {
    schema: BUNDLE_REPLAY_BATCH_SCHEMA,
    generatedAt: new Date().toISOString(),
    total: reports.length,
    cleanCount: counts.clean,
    warningsCount: counts.warnings,
    tamperedCount: counts.tampered,
    missingCount: counts.missing,
    reports,
    topIssues: issues.slice(0, 10),
  };
}

export function renderBundleReplayBatchHtml(batch: IBundleReplayBatch): string {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const parts: string[] = [];
  parts.push('<!doctype html><html><head><meta charset="utf-8">');
  parts.push('<title>SharkCraft bundle replay (all)</title>');
  parts.push(
    '<style>body{font:14px/1.5 -apple-system,sans-serif;max-width:1080px;margin:24px auto;padding:0 16px}h1{font-size:20px;border-bottom:1px solid #d0d7de;padding-bottom:8px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left}th{background:#f6f8fa}.tag{display:inline-block;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600}.tag.ok{background:#dafbe1;color:#1a7f37}.tag.warn{background:#fff8c5;color:#9a6700}.tag.fail{background:#ffebe9;color:#cf222e}</style></head><body>',
  );
  parts.push(`<h1>Bundle replay (${batch.total})</h1>`);
  parts.push(
    `<p>Clean: <span class="tag ok">${batch.cleanCount}</span> · Warnings: <span class="tag warn">${batch.warningsCount}</span> · Tampered: <span class="tag fail">${batch.tamperedCount}</span> · Missing: ${batch.missingCount}</p>`,
  );
  parts.push('<table><thead><tr><th>Bundle</th><th>Status</th><th>Audit entries</th><th>Issues</th></tr></thead><tbody>');
  for (const r of batch.reports) {
    const tag = r.status === 'clean' ? 'ok' : r.status === 'warnings' ? 'warn' : 'fail';
    const issuesCount = r.planEntries.reduce((acc, p) => acc + p.issues.length, 0) + r.warnings.length;
    parts.push(
      `<tr><td><code>${esc(r.bundleId)}</code></td><td><span class="tag ${tag}">${esc(r.status.toUpperCase())}</span></td><td>${r.auditEntries}</td><td>${issuesCount}</td></tr>`,
    );
  }
  parts.push('</tbody></table>');
  if (batch.topIssues.length > 0) {
    parts.push('<h2>Top issues</h2><ul>');
    for (const i of batch.topIssues) {
      parts.push(
        `<li><code>${esc(i.bundleId)}</code>${i.planName ? ` / <code>${esc(i.planName)}</code>` : ''} — ${esc(i.code)}: ${esc(i.message)}</li>`,
      );
    }
    parts.push('</ul>');
  }
  parts.push('</body></html>');
  return parts.join('\n') + '\n';
}

function buildRecommendedFix(
  bundle: IFeatureBundle,
  status: BundleReplayStatus,
  warnings: readonly IBundleReplayWarning[],
  planEntries: readonly IBundleReplayPlanEntry[],
): string | null {
  if (status === BundleReplayStatus.Clean) return null;
  if (warnings.some((w) => w.code === 'no-validation-after-apply')) {
    return `shrk bundle validate ${bundle.id} --all-verifications --report`;
  }
  if (planEntries.some((p) => p.issues.includes('plan file missing on disk'))) {
    return `Replan with \`shrk bundle plan ${bundle.id} --template <id>\` to re-create missing plan files.`;
  }
  if (warnings.some((w) => w.code === 'out-of-order-apply')) {
    return 'Investigate dependency order in apply-audit.log; consider rolling back affected plans.';
  }
  return `Re-run \`shrk bundle replay ${bundle.id} --strict\` after addressing issues.`;
}
