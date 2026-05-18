/**
 * Compliance evidence packets.
 *
 * Produces a directory of read-only evidence for a compliance profile:
 * the compliance report, plus copies of available local artefacts
 * (safety audit, release readiness, packs doctor JSON when present),
 * a docs-presence list, and a manifest.
 *
 * Manifest includes per-file SHA-256 + git commit hash + SharkCraft
 * version. `--sign` adds an HMAC-SHA256 signature over the manifest
 * (secret from `SHARKCRAFT_EVIDENCE_SECRET`). `--verify` recomputes
 * file hashes and (when present) the manifest signature. `--zip`
 * produces a single archive when `tar` is available locally; when
 * unavailable, the directory output is returned with a clear warning.
 *
 * No external network. No certification claims.
 */
import { spawnSync } from 'node:child_process';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  runComplianceCheck,
  type IComplianceCheckReport,
} from './compliance-profiles.ts';
import { getGitRoot } from './git-helpers.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const COMPLIANCE_EVIDENCE_SCHEMA = 'sharkcraft.compliance-evidence/v1';

export interface IComplianceEvidenceManifestEntry {
  kind: string;
  file: string;
  bytes: number;
  sha256: string;
  source?: string;
}

export interface IComplianceEvidenceManifest {
  schema: typeof COMPLIANCE_EVIDENCE_SCHEMA;
  generatedAt: string;
  profileId: string;
  sharkcraftVersion: string;
  gitCommit?: string;
  entries: readonly IComplianceEvidenceManifestEntry[];
  signature?: { algorithm: 'hmac-sha256'; value: string };
}

export interface IComplianceEvidencePacket {
  schema: typeof COMPLIANCE_EVIDENCE_SCHEMA;
  generatedAt: string;
  profileId: string;
  outputDir: string;
  manifest: readonly IComplianceEvidenceManifestEntry[];
  report: IComplianceCheckReport;
  zipFile?: string;
  signed: boolean;
  warnings: readonly string[];
}

export interface IBuildComplianceEvidenceOptions {
  zip?: boolean;
  sign?: boolean;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function readSharkcraftVersion(inspection: ISharkcraftInspection): string {
  try {
    const pkgPath = nodePath.join(inspection.projectRoot, 'package.json');
    if (!existsSync(pkgPath)) return 'unknown';
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return parsed.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function readGitCommit(projectRoot: string): string | undefined {
  const root = getGitRoot(projectRoot);
  if (!root) return undefined;
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' });
  if (res.status !== 0) return undefined;
  const out = (res.stdout ?? '').trim();
  return out.length > 0 ? out : undefined;
}

function copyIfExists(
  inspection: ISharkcraftInspection,
  outDir: string,
  rel: string,
  kindLabel: string,
  entries: IComplianceEvidenceManifestEntry[],
): void {
  const abs = nodePath.join(inspection.projectRoot, rel);
  if (!existsSync(abs)) return;
  const target = nodePath.join(outDir, nodePath.basename(rel));
  const body = readFileSync(abs);
  writeFileSync(target, body);
  entries.push({
    kind: kindLabel,
    file: target,
    bytes: body.byteLength,
    sha256: sha256(body),
    source: rel,
  });
}

export async function buildComplianceEvidencePacket(
  inspection: ISharkcraftInspection,
  profileId: string,
  outputDir: string,
  options: IBuildComplianceEvidenceOptions = {},
): Promise<IComplianceEvidencePacket> {
  const dir = nodePath.isAbsolute(outputDir)
    ? outputDir
    : nodePath.resolve(inspection.projectRoot, outputDir);
  mkdirSync(dir, { recursive: true });
  const report = await runComplianceCheck(inspection, profileId);
  const entries: IComplianceEvidenceManifestEntry[] = [];
  const warnings: string[] = [];

  // 1. Compliance report
  const reportFile = nodePath.join(dir, 'compliance-report.json');
  const reportBody = JSON.stringify(report, null, 2);
  writeFileSync(reportFile, reportBody, 'utf8');
  const reportBuf = Buffer.from(reportBody, 'utf8');
  entries.push({
    kind: 'compliance-report',
    file: reportFile,
    bytes: reportBuf.byteLength,
    sha256: sha256(reportBuf),
  });

  // 2. Fold local artefacts
  copyIfExists(inspection, dir, '.sharkcraft/reports/safety-audit.json', 'safety-audit', entries);
  copyIfExists(inspection, dir, '.sharkcraft/reports/release-readiness.json', 'release-readiness', entries);
  copyIfExists(inspection, dir, '.sharkcraft/reports/packs-doctor.json', 'packs-doctor', entries);
  copyIfExists(inspection, dir, '.sharkcraft/reports/quality.json', 'quality', entries);
  copyIfExists(inspection, dir, '.sharkcraft/reports/release-smoke.json', 'release-smoke', entries);
  copyIfExists(inspection, dir, '.sharkcraft/reports/self-audit.json', 'self-audit', entries);

  // 3. Docs evidence
  const docsList = [
    'docs/safety-model.md',
    'docs/security.md',
    'docs/plan-review.md',
    'docs/ci-scaffold.md',
    'docs/release-readiness.md',
  ].filter((d) => existsSync(nodePath.join(inspection.projectRoot, d)));
  const docsFile = nodePath.join(dir, 'docs-evidence.json');
  const docsBody = JSON.stringify({ docs: docsList }, null, 2);
  writeFileSync(docsFile, docsBody, 'utf8');
  const docsBuf = Buffer.from(docsBody, 'utf8');
  entries.push({
    kind: 'docs-evidence',
    file: docsFile,
    bytes: docsBuf.byteLength,
    sha256: sha256(docsBuf),
  });

  // 4. Manifest
  const gitCommit = readGitCommit(inspection.projectRoot);
  const sharkcraftVersion = readSharkcraftVersion(inspection);
  const manifest: IComplianceEvidenceManifest = {
    schema: COMPLIANCE_EVIDENCE_SCHEMA,
    generatedAt: new Date().toISOString(),
    profileId,
    sharkcraftVersion,
    ...(gitCommit ? { gitCommit } : {}),
    entries,
  };

  // 5. Sign (optional)
  let signed = false;
  if (options.sign === true) {
    const secret = process.env['SHARKCRAFT_EVIDENCE_SECRET'];
    if (!secret) {
      warnings.push(
        'Sign requested but `SHARKCRAFT_EVIDENCE_SECRET` is not set — manifest written without signature.',
      );
    } else {
      const payload = JSON.stringify({ ...manifest, signature: undefined });
      const hmac = createHmac('sha256', secret).update(payload).digest('hex');
      manifest.signature = { algorithm: 'hmac-sha256', value: hmac };
      signed = true;
    }
  }
  const manifestFile = nodePath.join(dir, 'manifest.json');
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf8');

  // 6. Zip (optional, best-effort via `tar`)
  let zipFile: string | undefined;
  if (options.zip === true) {
    const archiveName = `evidence-${profileId}.tar.gz`;
    const archivePath = nodePath.resolve(nodePath.dirname(dir), archiveName);
    const res = spawnSync('tar', ['czf', archivePath, '-C', nodePath.dirname(dir), nodePath.basename(dir)], {
      encoding: 'utf8',
    });
    if (res.status === 0) {
      zipFile = archivePath;
    } else {
      warnings.push(
        `Archive creation failed (tar exit ${res.status ?? 'unknown'}): ${(res.stderr ?? '').trim() || 'binary not available'}.`,
      );
    }
  }

  return {
    schema: COMPLIANCE_EVIDENCE_SCHEMA,
    generatedAt: manifest.generatedAt,
    profileId,
    outputDir: dir,
    manifest: entries,
    report,
    ...(zipFile ? { zipFile } : {}),
    signed,
    warnings,
  };
}

export function previewComplianceEvidencePacket(
  profileId: string,
): { plannedFiles: readonly string[]; nextCommand: string } {
  return {
    plannedFiles: [
      'compliance-report.json',
      'docs-evidence.json',
      'manifest.json',
      '(if present) safety-audit.json',
      '(if present) release-readiness.json',
      '(if present) packs-doctor.json',
      '(if present) quality.json',
      '(if present) release-smoke.json',
      '(if present) self-audit.json',
    ],
    nextCommand: `shrk compliance evidence ${profileId} --output .sharkcraft/compliance-evidence/${profileId}`,
  };
}

export interface IComplianceEvidenceVerification {
  manifestPath: string;
  ok: boolean;
  errors: readonly string[];
  warnings: readonly string[];
  fileResults: readonly {
    file: string;
    expectedSha256: string;
    actualSha256: string;
    ok: boolean;
  }[];
  signatureChecked: boolean;
  signatureOk?: boolean;
}

export function verifyComplianceEvidencePacket(
  targetPathOrDir: string,
): IComplianceEvidenceVerification {
  const stat = statSync(targetPathOrDir);
  let manifestPath: string;
  if (stat.isDirectory()) {
    manifestPath = nodePath.join(targetPathOrDir, 'manifest.json');
  } else {
    manifestPath = targetPathOrDir;
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!existsSync(manifestPath)) {
    return {
      manifestPath,
      ok: false,
      errors: [`Manifest not found at ${manifestPath}`],
      warnings,
      fileResults: [],
      signatureChecked: false,
    };
  }
  let manifest: IComplianceEvidenceManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as IComplianceEvidenceManifest;
  } catch (e) {
    return {
      manifestPath,
      ok: false,
      errors: [`Manifest JSON parse failed: ${(e as Error).message}`],
      warnings,
      fileResults: [],
      signatureChecked: false,
    };
  }
  const dir = nodePath.dirname(manifestPath);
  const fileResults: { file: string; expectedSha256: string; actualSha256: string; ok: boolean }[] = [];
  for (const entry of manifest.entries) {
    const filePath = nodePath.isAbsolute(entry.file)
      ? entry.file
      : nodePath.join(dir, nodePath.basename(entry.file));
    if (!existsSync(filePath)) {
      errors.push(`Listed file not found: ${entry.file}`);
      fileResults.push({ file: entry.file, expectedSha256: entry.sha256, actualSha256: '', ok: false });
      continue;
    }
    const actual = sha256(readFileSync(filePath));
    const ok = actual === entry.sha256;
    if (!ok) errors.push(`SHA256 mismatch for ${entry.file}`);
    fileResults.push({ file: entry.file, expectedSha256: entry.sha256, actualSha256: actual, ok });
  }

  let signatureChecked = false;
  let signatureOk: boolean | undefined;
  if (manifest.signature) {
    signatureChecked = true;
    const secret = process.env['SHARKCRAFT_EVIDENCE_SECRET'];
    if (!secret) {
      warnings.push('Signature present but `SHARKCRAFT_EVIDENCE_SECRET` not set — cannot verify.');
      signatureOk = false;
    } else {
      const { signature, ...rest } = manifest;
      const payload = JSON.stringify({ ...rest, signature: undefined });
      const expected = createHmac('sha256', secret).update(payload).digest('hex');
      const a = Buffer.from(expected, 'hex');
      const b = Buffer.from(signature.value, 'hex');
      signatureOk = a.length === b.length && timingSafeEqual(a, b);
      if (!signatureOk) errors.push('Manifest signature does not match.');
    }
  }

  return {
    manifestPath,
    ok: errors.length === 0,
    errors,
    warnings,
    fileResults,
    signatureChecked,
    ...(signatureOk !== undefined ? { signatureOk } : {}),
  };
}
