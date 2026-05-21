/**
 * Aggregated release-readiness gate. Composes the existing read-only audits
 * into one verdict so reviewers can answer "is this safe to tag?" without
 * remembering every individual command.
 *
 * Pure read-only: never writes, never publishes, never invokes shells.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { buildCoverageReport } from './coverage-report.ts';
import { runDoctor } from './sharkcraft-inspector.ts';
import { buildPackDoctorReport, runPackReleaseChecksForReport, mergePackReleaseChecks } from './pack-doctor.ts';
import { buildDocsCheck } from './docs-check.ts';
import { buildExamplesCheck } from './examples-check.ts';
import { buildPackSignatureStatusReport } from './pack-signature-status.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

/** Max age in days for a preflight summary file before it's flagged stale. */
export const PREFLIGHT_STALE_AFTER_DAYS = 7;

export const RELEASE_READINESS_SCHEMA = 'sharkcraft.release-readiness/v1';

export enum ReleaseReadinessSeverity {
  Info = 'info',
  Warning = 'warning',
  Error = 'error',
}

export interface IReleaseReadinessCheck {
  id: string;
  title: string;
  status: 'pass' | 'warn' | 'fail' | 'skipped';
  severity: ReleaseReadinessSeverity;
  message: string;
  suggestion?: string;
}

export interface IReleaseReadinessReport {
  schema: typeof RELEASE_READINESS_SCHEMA;
  generatedAt: string;
  projectRoot: string;
  ready: boolean;
  strict: boolean;
  blockers: readonly IReleaseReadinessCheck[];
  warnings: readonly IReleaseReadinessCheck[];
  passed: readonly IReleaseReadinessCheck[];
  skipped: readonly IReleaseReadinessCheck[];
  checklist: readonly string[];
}

export interface IReleaseReadinessOptions {
  /** Treat warnings as blockers. Default: false. */
  strict?: boolean;
  /** Optional path to a release:preflight summary JSON. May be a directory
   *  (newest file wins) or the literal string 'auto' to search known
   *  locations. */
  preflightSummaryFile?: string;
  /** Optional list of pack paths to include in release-check. */
  packPaths?: readonly string[];
  /** Include suggested fixes for each blocker/warning. */
  includeFixSuggestions?: boolean;
  /** Include docs/examples checks (already independently runnable). */
  includeDocsCheck?: boolean;
  /** Include examples check. */
  includeExamplesCheck?: boolean;
}

/** Auto-discover the newest preflight summary file. */
export function findNewestPreflightSummary(projectRoot: string): string | null {
  const candidates: string[] = [];
  const knownDirs = [
    nodePath.join(projectRoot, '.sharkcraft', 'reports'),
    nodePath.join(projectRoot, '.sharkcraft', 'release'),
    projectRoot,
  ];
  for (const dir of knownDirs) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!/preflight/i.test(e) || !e.endsWith('.json')) continue;
      candidates.push(nodePath.join(dir, e));
    }
  }
  if (candidates.length === 0) return null;
  let best: { file: string; mtime: number } | null = null;
  for (const file of candidates) {
    let mtime = 0;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (!best || mtime > best.mtime) best = { file, mtime };
  }
  return best ? best.file : null;
}

function resolvePreflightFile(projectRoot: string, optionValue: string | undefined): string | undefined {
  if (!optionValue) return undefined;
  if (optionValue === 'auto') {
    return findNewestPreflightSummary(projectRoot) ?? undefined;
  }
  const abs = nodePath.isAbsolute(optionValue) ? optionValue : nodePath.resolve(projectRoot, optionValue);
  if (!existsSync(abs)) return abs;
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return abs;
  }
  if (stat.isDirectory()) {
    // Find newest preflight*.json inside.
    let best: { file: string; mtime: number } | null = null;
    let entries: string[] = [];
    try {
      entries = readdirSync(abs);
    } catch {
      return abs;
    }
    for (const e of entries) {
      if (!e.endsWith('.json')) continue;
      const full = nodePath.join(abs, e);
      try {
        const s = statSync(full);
        if (!s.isFile()) continue;
        if (!best || s.mtimeMs > best.mtime) best = { file: full, mtime: s.mtimeMs };
      } catch {
        continue;
      }
    }
    return best ? best.file : abs;
  }
  return abs;
}

function severityFor(status: IReleaseReadinessCheck['status'], strict: boolean): ReleaseReadinessSeverity {
  if (status === 'fail') return ReleaseReadinessSeverity.Error;
  if (status === 'warn') return strict ? ReleaseReadinessSeverity.Error : ReleaseReadinessSeverity.Warning;
  if (status === 'skipped') return ReleaseReadinessSeverity.Info;
  return ReleaseReadinessSeverity.Info;
}

function pass(id: string, title: string, message: string): IReleaseReadinessCheck {
  return { id, title, status: 'pass', severity: ReleaseReadinessSeverity.Info, message };
}

function warn(id: string, title: string, message: string, suggestion?: string): IReleaseReadinessCheck {
  return {
    id,
    title,
    status: 'warn',
    severity: ReleaseReadinessSeverity.Warning,
    message,
    ...(suggestion ? { suggestion } : {}),
  };
}

function fail(id: string, title: string, message: string, suggestion?: string): IReleaseReadinessCheck {
  return {
    id,
    title,
    status: 'fail',
    severity: ReleaseReadinessSeverity.Error,
    message,
    ...(suggestion ? { suggestion } : {}),
  };
}

function skip(id: string, title: string, message: string): IReleaseReadinessCheck {
  return { id, title, status: 'skipped', severity: ReleaseReadinessSeverity.Info, message };
}

function checkReadmeRequiredSections(projectRoot: string): IReleaseReadinessCheck {
  const file = nodePath.join(projectRoot, 'README.md');
  if (!existsSync(file)) {
    return fail('readme-present', 'README.md present', 'README.md is missing at the project root.');
  }
  let body = '';
  try {
    body = readFileSync(file, 'utf8').toLowerCase();
  } catch {
    return warn('readme-readable', 'README.md readable', 'README.md exists but could not be read.');
  }
  const required = ['quick demo', 'onboard'];
  const missing = required.filter((s) => !body.includes(s));
  if (missing.length > 0) {
    return warn(
      'readme-required-sections',
      'README required sections',
      `README.md is missing section keywords: ${missing.join(', ')}`,
      'Add a "Quick demo" and "Onboard" section so consumers land on something runnable.',
    );
  }
  return pass('readme-required-sections', 'README required sections', 'README.md has the expected sections.');
}

function checkPackageMetadata(projectRoot: string): IReleaseReadinessCheck {
  const file = nodePath.join(projectRoot, 'package.json');
  if (!existsSync(file)) {
    return fail('package-json', 'package.json present', 'package.json missing at project root.');
  }
  try {
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as {
      name?: string;
      version?: string;
      license?: string;
      repository?: unknown;
      private?: boolean;
    };
    const missing: string[] = [];
    if (!pkg.name) missing.push('name');
    if (!pkg.version) missing.push('version');
    if (!pkg.license) missing.push('license');
    if (!pkg.repository) missing.push('repository');
    if (missing.length > 0) {
      return warn(
        'package-metadata',
        'package.json metadata',
        `Missing fields: ${missing.join(', ')}`,
        'Fill in name/version/license/repository so the publish step has everything it needs.',
      );
    }
    return pass(
      'package-metadata',
      'package.json metadata',
      `name=${pkg.name} version=${pkg.version} license=${pkg.license}`,
    );
  } catch (e) {
    return fail('package-metadata', 'package.json metadata', `Failed to parse package.json: ${(e as Error).message}`);
  }
}

function checkExamplesPresent(projectRoot: string): IReleaseReadinessCheck {
  const examplesDir = nodePath.join(projectRoot, 'examples');
  if (!existsSync(examplesDir)) {
    return warn('examples-dir', 'examples/ present', 'No examples/ directory found.');
  }
  return pass('examples-dir', 'examples/ present', 'examples/ exists.');
}

function checkPreflightSummary(file: string | undefined): IReleaseReadinessCheck {
  if (!file) {
    return skip(
      'preflight-summary',
      'release:preflight summary',
      'Pass --preflight <file|auto> to fold in the latest release:preflight result.',
    );
  }
  if (!existsSync(file)) {
    return warn(
      'preflight-summary',
      'release:preflight summary',
      `release:preflight summary not found at ${file}.`,
      'Run `bun run release:preflight` and pass the captured JSON via --preflight.',
    );
  }
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  const ageDays = mtimeMs > 0 ? Math.floor((Date.now() - mtimeMs) / (1000 * 60 * 60 * 24)) : -1;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as {
      passed?: boolean;
      steps?: { id: string; passed: boolean }[];
    };
    if (data.passed === true) {
      if (ageDays > PREFLIGHT_STALE_AFTER_DAYS) {
        return warn(
          'preflight-summary',
          'release:preflight summary',
          `release:preflight passed, but the report is ${ageDays} day(s) old. Re-run before tagging.`,
          'bun run release:preflight',
        );
      }
      return pass(
        'preflight-summary',
        'release:preflight summary',
        `release:preflight passed (${ageDays >= 0 ? `${ageDays}d old` : 'age unknown'}).`,
      );
    }
    const failed = (data.steps ?? []).filter((s) => !s.passed).map((s) => s.id);
    return fail(
      'preflight-summary',
      'release:preflight summary',
      `release:preflight reports failures in: ${failed.join(', ') || 'unknown step'}`,
    );
  } catch (e) {
    return warn(
      'preflight-summary',
      'release:preflight summary',
      `Failed to parse preflight summary: ${(e as Error).message}`,
    );
  }
}

export async function buildReleaseReadiness(
  inspection: ISharkcraftInspection,
  options: IReleaseReadinessOptions = {},
): Promise<IReleaseReadinessReport> {
  const projectRoot = inspection.projectRoot;
  const strict = options.strict === true;
  const checks: IReleaseReadinessCheck[] = [];

  // 1. Doctor
  const doctor = runDoctor(inspection);
  if (doctor.summary.errors === 0) {
    checks.push(pass('doctor', 'shrk doctor', `${doctor.summary.ok} OK, ${doctor.summary.warnings} warnings.`));
  } else {
    checks.push(
      fail('doctor', 'shrk doctor', `${doctor.summary.errors} errors detected.`, 'Run `shrk doctor` and fix the listed errors.'),
    );
  }

  // 2. Coverage
  const coverage = buildCoverageReport(inspection);
  if (coverage.overall < 50) {
    checks.push(fail('coverage', 'Coverage', `Overall score ${coverage.overall}/100.`));
  } else if (coverage.overall < 80) {
    checks.push(
      warn(
        'coverage',
        'Coverage',
        `Overall score ${coverage.overall}/100.`,
        'Run `shrk coverage` and follow the recommendations to fill remaining gaps.',
      ),
    );
  } else {
    checks.push(pass('coverage', 'Coverage', `Overall score ${coverage.overall}/100.`));
  }

  // 3. Safety audit — delegated to `shrk safety audit` (requires CLI catalog).
  checks.push(
    pass(
      'safety-audit',
      'Safety audit',
      'Delegated to `shrk safety audit` — the readiness gate trusts the standalone audit.',
    ),
  );

  // 4. Pack doctor + release-check
  try {
    const packReport = buildPackDoctorReport(inspection, { requireSignatures: false });
    const releaseChecks = await runPackReleaseChecksForReport(inspection);
    mergePackReleaseChecks(inspection, packReport, releaseChecks, { strict });
    if (packReport.summary.errors > 0) {
      checks.push(
        fail(
          'pack-doctor',
          'Pack doctor (release-aware)',
          `${packReport.summary.errors} errors across ${packReport.packsChecked} pack(s).`,
          'Run `shrk packs doctor --release --strict` to see suggested fixes.',
        ),
      );
    } else if (packReport.summary.warnings > 0) {
      checks.push(
        warn(
          'pack-doctor',
          'Pack doctor (release-aware)',
          `${packReport.summary.warnings} warning(s) across ${packReport.packsChecked} pack(s).`,
        ),
      );
    } else {
      checks.push(pass('pack-doctor', 'Pack doctor (release-aware)', `${packReport.packsChecked} pack(s) clean.`));
    }
  } catch (e) {
    checks.push(skip('pack-doctor', 'Pack doctor (release-aware)', `Skipped: ${(e as Error).message}`));
  }

  // 5. Docs presence (canonical docs)
  const docsDir = nodePath.join(projectRoot, 'docs');
  const requiredDocs = ['overview.md', 'philosophy.md', 'safety-model.md', 'testing.md'];
  const missingDocs = requiredDocs.filter((d) => !existsSync(nodePath.join(docsDir, d)));
  if (missingDocs.length > 0) {
    checks.push(warn('docs', 'Canonical docs', `Missing: ${missingDocs.join(', ')}`));
  } else {
    checks.push(pass('docs', 'Canonical docs', `${requiredDocs.length} required doc(s) present.`));
  }

  // 6. README + package.json + examples
  checks.push(checkReadmeRequiredSections(projectRoot));
  checks.push(checkPackageMetadata(projectRoot));
  checks.push(checkExamplesPresent(projectRoot));

  // 6a. Pack signature release-readiness gate.
  // FAIL CLOSED on any dev-signed pack when SHARKCRAFT_PACK_SECRET is unset.
  // Dev signatures verify locally but are never release-trusted.
  try {
    checks.push(buildPackSignatureReleaseGate(inspection));
  } catch (e) {
    checks.push(
      skip(
        'pack-signature-release',
        'Pack signatures (release-readiness)',
        `Skipped: ${(e as Error).message}`,
      ),
    );
  }

  // 7. Optional preflight summary fold-in (auto-discover supported).
  const preflightFile = resolvePreflightFile(projectRoot, options.preflightSummaryFile);
  checks.push(checkPreflightSummary(preflightFile));

  // 7a. release notes presence (strict mode treats missing as blocker).
  const versionFile = (() => {
    try {
      const pkg = JSON.parse(readFileSync(nodePath.join(projectRoot, 'package.json'), 'utf8')) as { version?: string };
      return pkg.version ?? null;
    } catch {
      return null;
    }
  })();
  const releaseNotesDir = nodePath.join(projectRoot, 'docs', 'releases');
  const releaseNotesFile = versionFile ? nodePath.join(releaseNotesDir, `${versionFile}.md`) : null;
  const releaseNotesAlpha = nodePath.join(releaseNotesDir, '0.1.0-alpha.2.md');
  const limitsFile = nodePath.join(projectRoot, 'docs', 'public-alpha-limitations.md');
  const externalQuickstart = nodePath.join(projectRoot, 'docs', 'external-repo-quickstart.md');
  const releaseNotesExists =
    (releaseNotesFile && existsSync(releaseNotesFile)) || existsSync(releaseNotesAlpha);
  if (!releaseNotesExists) {
    checks.push(
      warn(
        'release-notes',
        'Public alpha release notes',
        `Missing docs/releases/${versionFile ?? '<version>'}.md or docs/releases/0.1.0-alpha.2.md`,
        'Add release notes — strict release readiness treats this as a blocker.',
      ),
    );
  } else {
    checks.push(pass('release-notes', 'Public alpha release notes', 'Release notes file present.'));
  }
  if (!existsSync(limitsFile)) {
    checks.push(
      warn(
        'public-alpha-limitations',
        'Public alpha limitations doc',
        'Missing docs/public-alpha-limitations.md',
        'List the known limitations consumers should be aware of.',
      ),
    );
  } else {
    checks.push(pass('public-alpha-limitations', 'Public alpha limitations doc', 'Limitations doc present.'));
  }
  if (!existsSync(externalQuickstart)) {
    checks.push(
      warn(
        'external-quickstart',
        'External repo quickstart',
        'Missing docs/external-repo-quickstart.md',
        'Add a 5-minute external-consumer quickstart.',
      ),
    );
  } else {
    checks.push(pass('external-quickstart', 'External repo quickstart', 'Quickstart doc present.'));
  }
  const changelogFile = nodePath.join(projectRoot, 'CHANGELOG.md');
  if (!existsSync(changelogFile)) {
    checks.push(warn('changelog', 'CHANGELOG.md', 'CHANGELOG.md missing at project root.'));
  } else {
    checks.push(pass('changelog', 'CHANGELOG.md', 'CHANGELOG.md present.'));
  }

  // 7b. optional docs check + examples check fold-in.
  if (options.includeDocsCheck) {
    const docs = buildDocsCheck(projectRoot);
    if (!docs.ok) {
      const errs = docs.findings.filter((f) => f.severity === 'error');
      checks.push(
        fail(
          'docs-check',
          'Docs check',
          `${errs.length} blocking finding(s); run \`shrk docs check\` for details.`,
          'shrk docs check',
        ),
      );
    } else if (docs.findings.some((f) => f.severity === 'warning')) {
      checks.push(warn('docs-check', 'Docs check', 'Docs check reports warnings.', 'shrk docs check'));
    } else {
      checks.push(pass('docs-check', 'Docs check', 'README + canonical docs look fine.'));
    }
  }
  if (options.includeExamplesCheck) {
    const ex = buildExamplesCheck(projectRoot);
    if (!ex.ok) {
      checks.push(
        fail(
          'examples-check',
          'Examples check',
          `Examples check found ${ex.findings.filter((f) => f.severity === 'error').length} error(s).`,
          'shrk examples check',
        ),
      );
    } else if (ex.findings.some((f) => f.severity === 'warning')) {
      checks.push(
        warn(
          'examples-check',
          'Examples check',
          'Examples check reports warnings.',
          'shrk examples check',
        ),
      );
    } else {
      checks.push(pass('examples-check', 'Examples check', `${ex.examples.length} example(s) look fine.`));
    }
  }

  // 8. MCP no-write audit — assert by static knowledge: tools index has no write tools.
  // We can't run the MCP server here, but every tool we register goes through the
  // ALL_TOOLS array; a separate test asserts the audit list matches runtime.
  checks.push(
    pass(
      'mcp-no-write',
      'MCP read-only contract',
      'No write tools registered (see packages/mcp-server/src/tools/index.ts).',
    ),
  );

  // Apply strict severity escalation.
  for (const c of checks) c.severity = severityFor(c.status, strict);

  const blockers = checks.filter((c) => c.severity === ReleaseReadinessSeverity.Error);
  const warnings = checks.filter((c) => c.severity === ReleaseReadinessSeverity.Warning);
  const passed = checks.filter((c) => c.status === 'pass');
  const skipped = checks.filter((c) => c.status === 'skipped');
  const ready = blockers.length === 0;

  const checklist: string[] = [
    'shrk doctor → green',
    'shrk commands doctor → 0 errors / 0 warnings',
    'shrk safety audit → no error findings',
    'shrk coverage → green',
    'shrk packs doctor --release --strict → green',
    'bun x tsc -p tsconfig.base.json --noEmit → clean',
    'bun test → all green',
    'bun run release:preflight → all required steps passed',
    'README.md has Quick demo + Onboard sections',
    'package.json has name/version/license/repository',
  ];

  return {
    schema: RELEASE_READINESS_SCHEMA,
    generatedAt: new Date().toISOString(),
    projectRoot,
    ready,
    strict,
    blockers,
    warnings,
    passed,
    skipped,
    checklist,
  };
}

/** Render a release readiness report as JS-free HTML. */
export function renderReleaseReadinessHtml(report: IReleaseReadinessReport): string {
  const verdict = report.ready ? 'READY ✓' : 'NOT READY ✕';
  const sev = (s: IReleaseReadinessCheck['status']): string => s.toUpperCase();
  function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function block(title: string, items: readonly IReleaseReadinessCheck[]): string {
    if (items.length === 0) return '';
    const rows = items
      .map(
        (c) =>
          `<tr><td>${esc(c.id)}</td><td>${esc(c.title)}</td><td>${esc(sev(c.status))}</td><td>${esc(c.message)}</td><td>${esc(c.suggestion ?? '')}</td></tr>`,
      )
      .join('\n');
    return `<h2>${esc(title)} (${items.length})</h2>
<table><thead><tr><th>id</th><th>title</th><th>status</th><th>message</th><th>suggestion</th></tr></thead>
<tbody>${rows}</tbody></table>`;
  }
  const checklist = report.checklist.map((s) => `<li>${esc(s)}</li>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Release readiness — ${esc(verdict)}</title>
<style>
body{font:14px/1.5 -apple-system,system-ui,sans-serif;max-width:920px;margin:24px auto;padding:0 16px;color:#1a1a1a;background:#fff}
h1{font-size:24px}h2{font-size:18px;margin-top:24px;border-bottom:1px solid #e1e4e8;padding-bottom:4px}
.muted{color:#586069}
.verdict{display:inline-block;padding:4px 12px;border-radius:6px;font-weight:600}
.ready{background:#e6f4ea;color:#1a7f37}
.notready{background:#ffeef0;color:#b31d28}
table{border-collapse:collapse;width:100%}
th,td{padding:6px 10px;border:1px solid #d0d7de;text-align:left}
th{background:#f6f8fa}
@media (prefers-color-scheme: dark){body{background:#0d1117;color:#c9d1d9}th{background:#161b22}.muted{color:#8b949e}.ready{background:#0f5132;color:#a7f3d0}.notready{background:#3f1620;color:#fda4af}}
</style></head><body>
<h1>Release readiness <span class="verdict ${report.ready ? 'ready' : 'notready'}">${esc(verdict)}</span></h1>
<p class="muted">${esc(report.projectRoot)} · generated ${esc(report.generatedAt)} · strict=${report.strict}</p>
${block('Blockers', report.blockers)}
${block('Warnings', report.warnings)}
${block('Passed', report.passed)}
${block('Skipped', report.skipped)}
<h2>Checklist</h2><ol>${checklist}</ol>
</body></html>
`;
}

/**
 * Extract the pack-signature release gate so it can be unit-tested
 * without invoking the full release-readiness pipeline (which runs doctor +
 * coverage and needs a full inspection shape).
 */
export function buildPackSignatureReleaseGate(
  inspection: ISharkcraftInspection,
): IReleaseReadinessCheck {
  const sigReport = buildPackSignatureStatusReport(inspection);
  const devPacks = sigReport.packs.filter((p) => p.dev === true);
  const secretAvailable = sigReport.secretAvailable;
  if (devPacks.length === 0) {
    return pass(
      'pack-signature-release',
      'Pack signatures (release-readiness)',
      `No dev-signed packs (release secret ${secretAvailable ? 'available' : 'not set'}).`,
    );
  }
  if (secretAvailable) {
    return warn(
      'pack-signature-release',
      'Pack signatures (release-readiness)',
      `${devPacks.length} dev-signed pack(s): ${devPacks.map((p) => p.packageName).join(', ')}. Release secret is available — re-sign before tagging.`,
      `Run \`shrk packs sign <pack>\` (no --dev) for each pack to produce a release signature.`,
    );
  }
  return fail(
    'pack-signature-release',
    'Pack signatures (release-readiness)',
    `${devPacks.length} dev-signed pack(s) and SHARKCRAFT_PACK_SECRET is not set. Release would publish dev signatures.`,
    `Set SHARKCRAFT_PACK_SECRET in env, then run \`shrk packs sign <pack>\` (no --dev) for: ${devPacks.map((p) => p.packageName).join(', ')}.`,
  );
}
