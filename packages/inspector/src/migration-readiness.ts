import { existsSync, readFileSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';

/**
 * Generic migration readiness verdict. A migration profile is a list of named
 * checks that probe local files / reports / config — never running any source
 * code. The output is a deterministic JSON envelope an agent or a CI gate
 * can read.
 *
 * Migration profiles ship as data via `migrationProfileFiles` on a pack
 * manifest or via the optional `customProfiles` option below. The SharkCraft
 * engine no longer ships project-specific built-in profiles.
 */

export enum MigrationCheckStatus {
  Pass = 'pass',
  Warn = 'warn',
  Fail = 'fail',
  Skip = 'skip',
}

export enum MigrationVerdict {
  Blocked = 'blocked',
  ReadyExceptSigning = 'ready-except-signing',
  ReadyExceptBaseline = 'ready-except-baseline',
  ReadyExceptDedupe = 'ready-except-dedupe',
  ReadyExceptScriptSwitch = 'ready-except-script-switch',
  ReadyToDeprecate = 'ready-to-deprecate',
  ReadyToDelete = 'ready-to-delete',
}

export interface IMigrationCheck {
  id: string;
  title: string;
  description?: string;
  /** File existence / non-existence / contents probe. Resolved relative to projectRoot. */
  filePresent?: readonly string[];
  /** "at least one of" — passes if ANY listed path exists. Useful when a pack/file may live in either of two known locations after a rename. */
  filePresentAny?: readonly string[];
  fileAbsent?: readonly string[];
  /** Required env var; success if set (and non-empty). */
  envVar?: string;
  /** Optional category for grouping. */
  category?: 'pack' | 'parity' | 'baseline' | 'dedupe' | 'scripts' | 'doctor' | 'mcp' | 'playbook' | 'sequence';
  /** When true, failure does not block — only warns. */
  optional?: boolean;
  /** When set, the verdict reason if this exact check fails. */
  blockerReason?: MigrationVerdict;
}

export interface IMigrationProfile {
  id: string;
  title: string;
  description?: string;
  /** Final verdict (delete-target) name. */
  successVerdict: MigrationVerdict;
  checks: readonly IMigrationCheck[];
}

export interface IMigrationCheckResult {
  id: string;
  title: string;
  status: MigrationCheckStatus;
  message: string;
  category?: IMigrationCheck['category'];
  optional?: boolean;
  blockerReason?: MigrationVerdict;
}

export interface IMigrationReadinessReport {
  schema: 'sharkcraft.migration-readiness/v1';
  generatedAt: string;
  projectRoot: string;
  profileId: string;
  profileTitle: string;
  verdict: MigrationVerdict;
  ready: boolean;
  blockers: readonly IMigrationCheckResult[];
  warnings: readonly IMigrationCheckResult[];
  passed: readonly IMigrationCheckResult[];
  skipped: readonly IMigrationCheckResult[];
  checklist: readonly string[];
}

const BUILTIN_PROFILES: Record<string, IMigrationProfile> = Object.freeze({});

export interface IMigrationReadinessOptions {
  profileId: string;
  projectRoot: string;
  /**
   * Additional migration profiles to consult when resolving `profileId`.
   * Pack-loaded profiles arrive here from the CLI/MCP entrypoints; tests pass
   * fixture profiles directly.
   */
  customProfiles?: readonly IMigrationProfile[];
}

export interface IMigrationReadinessResolveResult {
  ok: boolean;
  profile?: IMigrationProfile;
  error?: string;
}

export function resolveMigrationProfile(
  profileId: string,
  customProfiles: readonly IMigrationProfile[] = [],
): IMigrationReadinessResolveResult {
  const custom = customProfiles.find((p) => p.id === profileId);
  const profile = BUILTIN_PROFILES[profileId] ?? custom;
  if (!profile) {
    const known = [...Object.keys(BUILTIN_PROFILES), ...customProfiles.map((p) => p.id)];
    return {
      ok: false,
      error: `Unknown migration profile: ${profileId}. Known: ${known.join(', ') || '(none — provide a customProfiles entry or pack-contributed migrationProfileFiles)'}`,
    };
  }
  return { ok: true, profile };
}

export function listMigrationProfiles(
  customProfiles: readonly IMigrationProfile[] = [],
): readonly IMigrationProfile[] {
  return [...Object.values(BUILTIN_PROFILES), ...customProfiles];
}

function checkOne(check: IMigrationCheck, projectRoot: string): IMigrationCheckResult {
  const fails: string[] = [];

  if (check.filePresent) {
    for (const rel of check.filePresent) {
      const abs = nodePath.join(projectRoot, rel);
      if (!existsSync(abs)) fails.push(`missing: ${rel}`);
    }
  }
  if (check.filePresentAny) {
    const hits = check.filePresentAny.filter((rel) => existsSync(nodePath.join(projectRoot, rel)));
    if (hits.length === 0) {
      fails.push(`none of: ${check.filePresentAny.join(', ')}`);
    }
  }
  if (check.fileAbsent) {
    for (const rel of check.fileAbsent) {
      const abs = nodePath.join(projectRoot, rel);
      if (existsSync(abs)) fails.push(`should be absent: ${rel}`);
    }
  }
  if (check.envVar) {
    const value = process.env[check.envVar];
    if (!value || value.length === 0) fails.push(`env ${check.envVar} not set`);
  }
  if (fails.length === 0) {
    return {
      id: check.id,
      title: check.title,
      status: MigrationCheckStatus.Pass,
      message: 'ok',
      ...(check.category ? { category: check.category } : {}),
      ...(check.optional ? { optional: true } : {}),
      ...(check.blockerReason ? { blockerReason: check.blockerReason } : {}),
    };
  }
  const status = check.optional ? MigrationCheckStatus.Warn : MigrationCheckStatus.Fail;
  return {
    id: check.id,
    title: check.title,
    status,
    message: fails.join('; '),
    ...(check.category ? { category: check.category } : {}),
    ...(check.optional ? { optional: true } : {}),
    ...(check.blockerReason ? { blockerReason: check.blockerReason } : {}),
  };
}

export function buildMigrationReadiness(options: IMigrationReadinessOptions): IMigrationReadinessReport {
  const { profileId, projectRoot, customProfiles } = options;
  const resolved = resolveMigrationProfile(profileId, customProfiles ?? []);
  if (!resolved.ok || !resolved.profile) {
    return {
      schema: 'sharkcraft.migration-readiness/v1',
      generatedAt: new Date().toISOString(),
      projectRoot,
      profileId,
      profileTitle: '(unknown profile)',
      verdict: MigrationVerdict.Blocked,
      ready: false,
      blockers: [
        {
          id: 'profile-unknown',
          title: 'Unknown migration profile',
          status: MigrationCheckStatus.Fail,
          message: resolved.error ?? 'unknown profile',
        },
      ],
      warnings: [],
      passed: [],
      skipped: [],
      checklist: [],
    };
  }
  const profile = resolved.profile;
  const blockers: IMigrationCheckResult[] = [];
  const warnings: IMigrationCheckResult[] = [];
  const passed: IMigrationCheckResult[] = [];
  const skipped: IMigrationCheckResult[] = [];

  for (const check of profile.checks) {
    const r = checkOne(check, projectRoot);
    if (r.status === MigrationCheckStatus.Fail) blockers.push(r);
    else if (r.status === MigrationCheckStatus.Warn) warnings.push(r);
    else if (r.status === MigrationCheckStatus.Skip) skipped.push(r);
    else passed.push(r);
  }

  // Verdict resolution: pick the most-specific blocker reason if a non-warn
  // failure exists; otherwise the success verdict.
  let verdict: MigrationVerdict = profile.successVerdict;
  let ready = true;
  if (blockers.length > 0) {
    ready = false;
    // Prefer a specific "ready-except-*" verdict over the generic "blocked".
    const specific = blockers.find((b) => b.blockerReason && b.blockerReason !== MigrationVerdict.Blocked);
    verdict = specific?.blockerReason ?? blockers[0]?.blockerReason ?? MigrationVerdict.Blocked;
  } else if (warnings.length > 0) {
    // All required checks passed; warnings mean we can deprecate but maybe not
    // delete immediately. Downgrade to ReadyToDeprecate when the success verdict
    // is ReadyToDelete.
    if (profile.successVerdict === MigrationVerdict.ReadyToDelete) {
      verdict = MigrationVerdict.ReadyToDeprecate;
    } else {
      verdict = profile.successVerdict;
    }
  }

  const checklist = [
    `Profile: ${profile.title} (${profile.id})`,
    `Verdict: ${verdict}`,
    `Passed: ${passed.length}, Warnings: ${warnings.length}, Blockers: ${blockers.length}`,
    'Next: review blockers (if any), then re-run `shrk migration readiness --profile ' +
      profile.id +
      '`.',
  ];

  return {
    schema: 'sharkcraft.migration-readiness/v1',
    generatedAt: new Date().toISOString(),
    projectRoot,
    profileId,
    profileTitle: profile.title,
    verdict,
    ready,
    blockers,
    warnings,
    passed,
    skipped,
    checklist,
  };
}

export function renderMigrationReadinessText(report: IMigrationReadinessReport): string {
  const lines: string[] = [];
  lines.push(`=== Migration readiness — ${report.profileTitle} ===`);
  lines.push(`  profile  ${report.profileId}`);
  lines.push(`  verdict  ${report.verdict}`);
  lines.push(`  ready    ${report.ready ? 'yes' : 'no'}`);
  lines.push(`  passed   ${report.passed.length}`);
  lines.push(`  warnings ${report.warnings.length}`);
  lines.push(`  blockers ${report.blockers.length}`);
  lines.push('');
  const groups: [string, readonly IMigrationCheckResult[]][] = [
    ['BLOCKERS', report.blockers],
    ['WARNINGS', report.warnings],
    ['PASSED', report.passed],
    ['SKIPPED', report.skipped],
  ];
  for (const [groupTitle, items] of groups) {
    if (items.length === 0) continue;
    lines.push(groupTitle);
    for (const item of items) {
      const cat = item.category ? `[${item.category}] ` : '';
      lines.push(`  - ${item.status.padEnd(5)} ${cat}${item.id.padEnd(28)} ${item.title}`);
      if (item.message && item.message !== 'ok') lines.push(`            ↳ ${item.message}`);
    }
    lines.push('');
  }
  lines.push('Checklist:');
  for (const item of report.checklist) lines.push(`  • ${item}`);
  return lines.join('\n') + '\n';
}

export function renderMigrationReadinessMarkdown(report: IMigrationReadinessReport): string {
  const lines: string[] = [];
  lines.push(`# Migration readiness — ${report.profileTitle}`);
  lines.push('');
  lines.push(`- **Profile:** \`${report.profileId}\``);
  lines.push(`- **Verdict:** \`${report.verdict}\``);
  lines.push(`- **Ready:** ${report.ready ? '✅' : '❌'}`);
  lines.push(`- Passed: ${report.passed.length}, Warnings: ${report.warnings.length}, Blockers: ${report.blockers.length}`);
  lines.push('');
  const groups: [string, readonly IMigrationCheckResult[]][] = [
    ['Blockers', report.blockers],
    ['Warnings', report.warnings],
    ['Passed', report.passed],
    ['Skipped', report.skipped],
  ];
  for (const [groupTitle, items] of groups) {
    if (items.length === 0) continue;
    lines.push(`## ${groupTitle}`);
    lines.push('');
    lines.push('| Status | Category | ID | Title | Detail |');
    lines.push('|---|---|---|---|---|');
    for (const item of items) {
      lines.push(`| ${item.status} | ${item.category ?? ''} | \`${item.id}\` | ${item.title} | ${item.message === 'ok' ? '' : item.message} |`);
    }
    lines.push('');
  }
  lines.push('## Checklist');
  lines.push('');
  for (const c of report.checklist) lines.push(`- ${c}`);
  return lines.join('\n') + '\n';
}

// Tiny helpers exported for tests.
export const __testing = {
  resolveMigrationProfile,
  checkOne,
};
void readFileSync;
void statSync;
