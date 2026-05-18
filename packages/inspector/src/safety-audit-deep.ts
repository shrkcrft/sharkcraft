/**
 * Deep safety audit.
 *
 * Augments the existing buildSafetyAudit output with read-only
 * structural checks: report site external JS scan, demo destructive
 * lines, CI permissions summary, release readiness state.
 *
 * Includes dev-signed pack enumeration. Dev signatures verify locally
 * (`shrk packs sign --dev`) but are never release-trusted — `safety
 * audit --deep` surfaces them so a release engineer sees them.
 *
 * The deep audit is purely additive — it does not change the canonical
 * safety audit output, it returns an extended object.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { buildPackSignatureStatusReport } from './pack-signature-status.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

/**
 * Schema bumped to v2: adds `infoOnlyFindings` so an agent can read
 * the dev-sig disposition without parsing checks[].
 */
export const SAFETY_AUDIT_DEEP_SCHEMA = 'sharkcraft.safety-audit-deep/v2';

export interface ISafetyAuditDeepCheck {
  id: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  evidence?: string;
}

export interface ISafetyAuditDeepReport {
  schema: typeof SAFETY_AUDIT_DEEP_SCHEMA;
  generatedAt: string;
  reportSiteExternalJs: readonly string[];
  demoDestructiveLines: readonly string[];
  ciGeneratedWorkflowPermissions: readonly { file: string; permissions: string }[];
  /** Packs whose latest signature is a dev signature (subset of valid packs). */
  devSignedPacks: readonly { packageName: string; packageVersion: string; signedAt?: string }[];
  checks: readonly ISafetyAuditDeepCheck[];
  /**
   * Count of info-level findings. The verdict (`passed`) ignores
   * info findings by design; this field surfaces them next to the verdict
   * so the text rendering can be honest without an agent parsing checks[].
   */
  infoOnlyFindings: number;
  passed: boolean;
}

const DESTRUCTIVE_RE = [/\brm\s+-rf\b/, /\bdd\s+if=/, /\bmkfs\b/];
const EXTERNAL_JS_RE = [/<script\s+[^>]*src=["']https?:/i, /from\s+['"]https?:/i];

function scanFile(file: string, patterns: readonly RegExp[]): readonly { line: number; text: string }[] {
  try {
    const lines = readFileSync(file, 'utf8').split('\n');
    const hits: { line: number; text: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      for (const p of patterns) {
        if (p.test(line)) {
          hits.push({ line: i + 1, text: line });
          break;
        }
      }
    }
    return hits;
  } catch {
    return [];
  }
}

function walkPattern(dir: string, ext: string, max: number): string[] {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length && out.length < max) {
    const cur = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (f.startsWith('.') || f === 'node_modules' || f === 'dist') continue;
      const full = nodePath.join(cur, f);
      try {
        const st = statSync(full);
        if (st.isDirectory()) stack.push(full);
        else if (full.endsWith(ext)) out.push(full);
      } catch {
        continue;
      }
    }
  }
  return out;
}

export async function buildSafetyAuditDeep(
  inspection: ISharkcraftInspection,
): Promise<ISafetyAuditDeepReport> {
  const projectRoot = inspection.projectRoot;
  const checks: ISafetyAuditDeepCheck[] = [];

  // 1. Report site external JS scan — scan the generator file.
  const reportSitePath = nodePath.join(projectRoot, 'packages/inspector/src/report-site.ts');
  const externalHits = existsSync(reportSitePath) ? scanFile(reportSitePath, EXTERNAL_JS_RE) : [];
  const reportSiteExternalJs = externalHits.map((h) => `report-site.ts:${h.line}`);
  if (externalHits.length > 0) {
    checks.push({
      id: 'report-site-external-js',
      severity: 'warning',
      message: `Report site source references external JS (${externalHits.length} hit(s)).`,
      evidence: externalHits.map((h) => `${h.line}: ${h.text.trim()}`).join('\n'),
    });
  }

  // 2. Demo destructive lines — scan docs/demo/ and demo-script output files.
  const demoDir = nodePath.join(projectRoot, 'docs/demo');
  const demoFiles = existsSync(demoDir) ? walkPattern(demoDir, '.sh', 50).concat(walkPattern(demoDir, '.md', 50)) : [];
  const destructive: string[] = [];
  for (const f of demoFiles) {
    const hits = scanFile(f, DESTRUCTIVE_RE);
    for (const h of hits) destructive.push(`${nodePath.relative(projectRoot, f)}:${h.line}`);
  }
  if (destructive.length > 0) {
    checks.push({
      id: 'demo-destructive-lines',
      severity: 'error',
      message: `Found ${destructive.length} destructive line(s) in docs/demo/.`,
      evidence: destructive.join('\n'),
    });
  }

  // 3. CI generated workflow permissions — best-effort scan for .github/workflows.
  const ciPerms: { file: string; permissions: string }[] = [];
  const workflowsDir = nodePath.join(projectRoot, '.github/workflows');
  if (existsSync(workflowsDir)) {
    const yml = walkPattern(workflowsDir, '.yml', 50).concat(walkPattern(workflowsDir, '.yaml', 50));
    for (const f of yml) {
      try {
        const t = readFileSync(f, 'utf8');
        const m = /^permissions\s*:\s*([\s\S]*?)(?=\n\S|$)/m.exec(t);
        ciPerms.push({ file: nodePath.relative(projectRoot, f), permissions: m ? (m[1] ?? '').trim() : '(none)' });
      } catch {
        continue;
      }
    }
  }

  // Dev-signed packs. One info-level line per dev-signed pack so a
  // release engineer running `safety audit --deep` sees them without
  // having to run a separate `packs signature-status`.
  let devSignedPacks: { packageName: string; packageVersion: string; signedAt?: string }[] = [];
  try {
    const sigReport = buildPackSignatureStatusReport(inspection);
    devSignedPacks = sigReport.packs
      .filter((p) => p.dev === true)
      .map((p) => ({
        packageName: p.packageName,
        packageVersion: p.packageVersion,
        ...(p.signatureSignedAt ? { signedAt: p.signatureSignedAt } : {}),
      }));
    for (const d of devSignedPacks) {
      checks.push({
        id: `dev-signed-pack:${d.packageName}`,
        severity: 'info',
        message: `Pack ${d.packageName}@${d.packageVersion} carries a dev signature.` +
          ' Dev signatures verify locally but are NOT release-trusted — re-sign with' +
          ' SHARKCRAFT_PACK_SECRET before tagging.',
        ...(d.signedAt ? { evidence: `signed-at: ${d.signedAt}` } : {}),
      });
    }
  } catch {
    // Best-effort — pack discovery failure shouldn't break the audit.
  }

  const passed = checks.every((c) => c.severity !== 'error');
  const infoOnlyFindings = checks.filter((c) => c.severity === 'info').length;

  return {
    schema: SAFETY_AUDIT_DEEP_SCHEMA,
    generatedAt: new Date().toISOString(),
    reportSiteExternalJs,
    demoDestructiveLines: destructive,
    ciGeneratedWorkflowPermissions: ciPerms,
    devSignedPacks,
    checks,
    infoOnlyFindings,
    passed,
  };
}
