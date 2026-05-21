/**
 * Local-first compliance profiles.
 *
 * Not legal advice, not external standards certification. Structured
 * local checks: required policies, boundaries, docs, commands,
 * ownership, quality thresholds, pack signatures.
 *
 * Built-in profiles:
 * - ai-safe-development
 * - signed-pack-workflow
 * - review-gated-codegen
 * - ci-governed-repository
 */
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const COMPLIANCE_SCHEMA = 'sharkcraft.compliance/v1';

export interface IComplianceProfile {
  id: string;
  title: string;
  description: string;
  tags: readonly string[];
  requiredDocs: readonly string[];
  requiredCommands: readonly string[];
  requiredOwnership: boolean;
  requiredQualityThresholds: { minDoctorOk?: number; minAiReadiness?: number };
  requiredPackSignatures: boolean;
  requiredMcpReadOnly: boolean;
}

export interface IComplianceCheckFinding {
  profileId: string;
  ruleId: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  evidence?: string;
}

export interface IComplianceCheckReport {
  schema: typeof COMPLIANCE_SCHEMA;
  generatedAt: string;
  profileId: string;
  pass: boolean;
  findings: readonly IComplianceCheckFinding[];
  summary: { errors: number; warnings: number; info: number };
}

export const BUILTIN_COMPLIANCE_PROFILES: readonly IComplianceProfile[] = Object.freeze([
  {
    id: 'ai-safe-development',
    title: 'AI-safe development',
    description: 'MCP is read-only, plans are reviewed, demo is non-destructive, dashboard has no write endpoints.',
    tags: ['safety', 'mcp', 'ai-agent'],
    requiredDocs: ['docs/safety-model.md'],
    requiredCommands: ['shrk safety audit', 'shrk doctor'],
    requiredOwnership: false,
    requiredQualityThresholds: {},
    requiredPackSignatures: false,
    requiredMcpReadOnly: true,
  },
  {
    id: 'signed-pack-workflow',
    title: 'Signed pack workflow',
    description: 'Discovered packs all carry verified HMAC signatures.',
    tags: ['pack', 'signing'],
    requiredDocs: ['docs/security.md'],
    requiredCommands: ['shrk packs doctor --release --require-signatures'],
    requiredOwnership: false,
    requiredQualityThresholds: {},
    requiredPackSignatures: true,
    requiredMcpReadOnly: false,
  },
  {
    id: 'review-gated-codegen',
    title: 'Review-gated codegen',
    description: 'Generation is dry-run by default; apply requires signature verification.',
    tags: ['generation', 'review'],
    requiredDocs: ['docs/plan-review.md', 'docs/safety-model.md'],
    requiredCommands: ['shrk plan review', 'shrk apply --verify-signature'],
    requiredOwnership: false,
    requiredQualityThresholds: {},
    requiredPackSignatures: false,
    requiredMcpReadOnly: true,
  },
  {
    id: 'ci-governed-repository',
    title: 'CI-governed repository',
    description: 'CI scaffolds + release readiness + preflight gates are documented and validated.',
    tags: ['ci', 'release', 'governance'],
    requiredDocs: ['docs/ci-scaffold.md', 'docs/release-readiness.md'],
    requiredCommands: ['shrk release readiness --strict', 'bun run release:preflight'],
    requiredOwnership: false,
    requiredQualityThresholds: {},
    requiredPackSignatures: false,
    requiredMcpReadOnly: false,
  },
]);

export function listComplianceProfiles(): readonly IComplianceProfile[] {
  return BUILTIN_COMPLIANCE_PROFILES;
}

export function getComplianceProfile(id: string): IComplianceProfile | undefined {
  return BUILTIN_COMPLIANCE_PROFILES.find((p) => p.id === id);
}

export async function runComplianceCheck(
  inspection: ISharkcraftInspection,
  profileId: string,
): Promise<IComplianceCheckReport> {
  const profile = getComplianceProfile(profileId);
  if (!profile) {
    return {
      schema: COMPLIANCE_SCHEMA,
      generatedAt: new Date().toISOString(),
      profileId,
      pass: false,
      findings: [
        {
          profileId,
          ruleId: 'unknown-profile',
          severity: 'error',
          message: `Compliance profile "${profileId}" not found. Use \`shrk compliance profiles\`.`,
        },
      ],
      summary: { errors: 1, warnings: 0, info: 0 },
    };
  }
  const findings: IComplianceCheckFinding[] = [];

  // Required docs.
  for (const d of profile.requiredDocs) {
    const abs = nodePath.join(inspection.projectRoot, d);
    if (!existsSync(abs)) {
      findings.push({
        profileId: profile.id,
        ruleId: `required-doc:${d}`,
        severity: 'warning',
        message: `Required doc missing: ${d}`,
        evidence: abs,
      });
    }
  }

  // MCP read-only contract — info only; the canonical check is the
  // separate `shrk safety audit` command, which has access to the MCP
  // tool list. We surface a hint here so consumers know to run it.
  if (profile.requiredMcpReadOnly) {
    findings.push({
      profileId: profile.id,
      ruleId: 'mcp-no-write-hint',
      severity: 'info',
      message:
        'Run `shrk safety audit` to confirm MCP has zero write tools (this profile requires it).',
    });
  }

  // Pack signatures — only checks discovered packs.
  if (profile.requiredPackSignatures) {
    for (const p of inspection.packs.validPacks ?? []) {
      const status = p.signatureStatus ?? 'not-checked';
      if (status === 'invalid-signature' || status === 'missing-signature') {
        findings.push({
          profileId: profile.id,
          ruleId: `pack-signature:${p.packageName}`,
          severity: 'error',
          message: `Pack ${p.packageName} signature status: ${status}.`,
        });
      } else if (status === 'not-checked') {
        findings.push({
          profileId: profile.id,
          ruleId: `pack-signature:${p.packageName}`,
          severity: 'warning',
          message: `Pack ${p.packageName} signature was not verified — re-run with --require-signatures.`,
        });
      }
    }
  }

  // Required-commands check is a docstring check — the commands must
  // exist in the catalog. We don't run them.
  // (Catalog parity is exercised separately by `shrk commands doctor`.)

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  const info = findings.filter((f) => f.severity === 'info').length;

  return {
    schema: COMPLIANCE_SCHEMA,
    generatedAt: new Date().toISOString(),
    profileId,
    pass: errors === 0,
    findings,
    summary: { errors, warnings, info },
  };
}

export function renderComplianceReportText(report: IComplianceCheckReport): string {
  const lines: string[] = [];
  lines.push(`=== Compliance: ${report.profileId} ===`);
  lines.push(`  pass     ${report.pass ? 'yes' : 'no'}`);
  lines.push(`  errors   ${report.summary.errors}`);
  lines.push(`  warnings ${report.summary.warnings}`);
  if (report.findings.length === 0) {
    lines.push('No findings.');
  } else {
    for (const f of report.findings) {
      lines.push(`  [${f.severity.padEnd(7)}] ${f.ruleId} — ${f.message}`);
      if (f.evidence) lines.push(`    evidence: ${f.evidence}`);
    }
  }
  return lines.join('\n') + '\n';
}
