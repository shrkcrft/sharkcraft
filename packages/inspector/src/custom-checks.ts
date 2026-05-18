/**
 * Custom checks registry and report convention.
 *
 * A "custom check" is a deterministic, project-script-style validation a
 * rule wants attached to it. The engine never executes the script unless
 * the user explicitly opts in (`shrk checks run --execute`). The report
 * convention is `sharkcraft.custom-check/v1`.
 *
 * Custom-check metadata lives on the rule entry under
 * `metadata.checks: ICustomCheckDescriptor[]`. The engine never invents
 * a check; we only inventory what authors declare.
 *
 * Hard rules:
 *   - No spawning a process by default.
 *   - Read-only inventory unless `--execute` is set explicitly.
 *   - Three input formats supported: JSON-report (preferred), text
 *     output, command-only (exit-code = signal).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { type IKnowledgeEntry, KnowledgeType } from '@shrkcrft/knowledge';

export const CUSTOM_CHECK_REPORT_SCHEMA = 'sharkcraft.custom-check/v1';
export const CUSTOM_CHECKS_REGISTRY_SCHEMA = 'sharkcraft.custom-checks-registry/v1';

export enum CustomCheckScope {
  ChangedOnly = 'changed-only',
  Staged = 'staged',
  All = 'all',
}

export enum CustomCheckKind {
  ImportGraph = 'import-graph',
  AstShape = 'ast-shape',
  TextShape = 'text-shape',
  ProjectScript = 'project-script',
  ExternalTool = 'external-tool',
}

export enum CustomCheckSafety {
  ReadOnly = 'read-only',
  WritesReport = 'writes-report',
  WritesPreview = 'writes-preview',
}

export enum CustomCheckOutput {
  Json = 'json',
  Text = 'text',
  ExitCode = 'exit-code',
}

export enum CustomCheckStatus {
  Pass = 'pass',
  Warn = 'warn',
  Fail = 'fail',
  Skipped = 'skipped',
}

export interface ICustomCheckDescriptor {
  /** Stable id (must be unique across the registry). */
  id: string;
  /** The rule that owns this check. The engine fills this in from context. */
  ownerRuleId?: string;
  /** Shell command to run (never executed unless --execute). */
  command: string;
  /** Where the script writes its report (relative to repo root). */
  reportPath?: string;
  /** Optional human description. */
  description?: string;
  scope?: CustomCheckScope;
  kind?: CustomCheckKind;
  safety?: CustomCheckSafety;
  output?: CustomCheckOutput;
  /** Tags for filtering. */
  tags?: readonly string[];
}

export interface ICustomCheckFinding {
  severity: 'error' | 'warning' | 'info';
  file?: string;
  message: string;
  suggestedAction?: string;
  safeToAutoFix?: boolean;
}

export interface ICustomCheckReport {
  schema: typeof CUSTOM_CHECK_REPORT_SCHEMA;
  checkId: string;
  ruleId?: string;
  generatedAt: string;
  status: CustomCheckStatus;
  findings: readonly ICustomCheckFinding[];
  /** Free-form metadata copied verbatim from the script. */
  metadata?: Readonly<Record<string, unknown>>;
}

export interface ICustomCheckRegistryEntry {
  descriptor: ICustomCheckDescriptor;
  ruleId: string;
  /** Validation findings about the descriptor itself. */
  warnings: readonly string[];
}

export interface ICustomCheckRegistry {
  schema: typeof CUSTOM_CHECKS_REGISTRY_SCHEMA;
  generatedAt: string;
  entries: readonly ICustomCheckRegistryEntry[];
  duplicates: readonly { id: string; ruleIds: readonly string[] }[];
  invalid: readonly { ruleId: string; reason: string }[];
}

const ID_RE = /^[a-z][a-z0-9.-]+$/;

/** Read the descriptors a rule declares under `metadata.checks`. */
export function readDescriptorsFromRule(rule: IKnowledgeEntry): readonly ICustomCheckDescriptor[] {
  const md = rule.metadata as Record<string, unknown> | undefined;
  const raw = md?.['checks'];
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => ({ ...(r as ICustomCheckDescriptor), ownerRuleId: rule.id }));
}

export function buildCustomChecksRegistry(
  entries: readonly IKnowledgeEntry[],
): ICustomCheckRegistry {
  const out: ICustomCheckRegistryEntry[] = [];
  const idIndex = new Map<string, string[]>();
  const invalid: { ruleId: string; reason: string }[] = [];

  for (const e of entries) {
    if (String(e.type) !== KnowledgeType.Rule) continue;
    const descriptors = readDescriptorsFromRule(e);
    for (const d of descriptors) {
      const warnings: string[] = [];
      if (!d.id || typeof d.id !== 'string') {
        invalid.push({ ruleId: e.id, reason: 'check entry missing string id' });
        continue;
      }
      if (!ID_RE.test(d.id)) {
        warnings.push(`id "${d.id}" should match ${ID_RE.source}`);
      }
      if (!d.command || typeof d.command !== 'string') {
        invalid.push({ ruleId: e.id, reason: `check "${d.id}" missing command` });
        continue;
      }
      if (d.output === CustomCheckOutput.Json && !d.reportPath) {
        warnings.push(`check "${d.id}" declares JSON output but has no reportPath`);
      }
      if (d.safety === undefined) {
        warnings.push(`check "${d.id}" did not declare safety; defaulting to read-only`);
      }
      const list = idIndex.get(d.id) ?? [];
      list.push(e.id);
      idIndex.set(d.id, list);
      out.push({ descriptor: d, ruleId: e.id, warnings });
    }
  }

  const duplicates: { id: string; ruleIds: readonly string[] }[] = [];
  for (const [id, ruleIds] of idIndex) {
    if (ruleIds.length > 1) duplicates.push({ id, ruleIds });
  }

  return {
    schema: CUSTOM_CHECKS_REGISTRY_SCHEMA,
    generatedAt: new Date().toISOString(),
    entries: out,
    duplicates,
    invalid,
  };
}

export interface ICustomCheckDoctorReport {
  schema: 'sharkcraft.custom-checks-doctor/v1';
  generatedAt: string;
  totalChecks: number;
  warnings: number;
  errors: number;
  details: readonly {
    ruleId: string;
    checkId: string;
    severity: 'error' | 'warning' | 'info';
    message: string;
  }[];
}

export function doctorCustomChecks(
  registry: ICustomCheckRegistry,
): ICustomCheckDoctorReport {
  const details: ICustomCheckDoctorReport['details'][number][] = [];
  for (const inv of registry.invalid) {
    details.push({ ruleId: inv.ruleId, checkId: '(invalid)', severity: 'error', message: inv.reason });
  }
  for (const dup of registry.duplicates) {
    details.push({
      ruleId: dup.ruleIds.join(','),
      checkId: dup.id,
      severity: 'error',
      message: `duplicate check id "${dup.id}" declared by rules ${dup.ruleIds.join(', ')}`,
    });
  }
  for (const e of registry.entries) {
    for (const w of e.warnings) {
      details.push({
        ruleId: e.ruleId,
        checkId: e.descriptor.id,
        severity: 'warning',
        message: w,
      });
    }
  }
  return {
    schema: 'sharkcraft.custom-checks-doctor/v1',
    generatedAt: new Date().toISOString(),
    totalChecks: registry.entries.length,
    warnings: details.filter((d) => d.severity === 'warning').length,
    errors: details.filter((d) => d.severity === 'error').length,
    details,
  };
}

/**
 * Parse a custom-check report from a known location. Supports the JSON
 * convention (preferred), and a text fallback that turns each line into
 * a `severity:warning, message: line` finding.
 */
export function parseCustomCheckReportFromFile(
  filePath: string,
  expectedCheckId?: string,
): { ok: true; report: ICustomCheckReport } | { ok: false; reason: string } {
  if (!existsSync(filePath)) {
    return { ok: false, reason: `report file does not exist: ${filePath}` };
  }
  const raw = readFileSync(filePath, 'utf8');
  return parseCustomCheckReport(raw, expectedCheckId);
}

export function parseCustomCheckReport(
  raw: string,
  expectedCheckId?: string,
): { ok: true; report: ICustomCheckReport } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty report' };
  if (trimmed.startsWith('{')) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch (e) {
      return { ok: false, reason: `JSON parse failed: ${(e as Error).message}` };
    }
    if (parsed['schema'] !== CUSTOM_CHECK_REPORT_SCHEMA) {
      return {
        ok: false,
        reason: `report schema mismatch — got "${String(parsed['schema'])}" expected "${CUSTOM_CHECK_REPORT_SCHEMA}"`,
      };
    }
    if (typeof parsed['checkId'] !== 'string') {
      return { ok: false, reason: 'report missing checkId' };
    }
    if (expectedCheckId && parsed['checkId'] !== expectedCheckId) {
      return {
        ok: false,
        reason: `report checkId "${String(parsed['checkId'])}" does not match expected "${expectedCheckId}"`,
      };
    }
    const findingsRaw = Array.isArray(parsed['findings']) ? (parsed['findings'] as Record<string, unknown>[]) : [];
    const findings: ICustomCheckFinding[] = findingsRaw.map((f) => ({
      severity: (f['severity'] as 'error' | 'warning' | 'info') ?? 'warning',
      file: typeof f['file'] === 'string' ? (f['file'] as string) : undefined,
      message: typeof f['message'] === 'string' ? (f['message'] as string) : '(no message)',
      suggestedAction: typeof f['suggestedAction'] === 'string' ? (f['suggestedAction'] as string) : undefined,
      safeToAutoFix: typeof f['safeToAutoFix'] === 'boolean' ? (f['safeToAutoFix'] as boolean) : false,
    }));
    const status = (parsed['status'] as CustomCheckStatus) ?? CustomCheckStatus.Pass;
    return {
      ok: true,
      report: {
        schema: CUSTOM_CHECK_REPORT_SCHEMA,
        checkId: parsed['checkId'] as string,
        ruleId: typeof parsed['ruleId'] === 'string' ? (parsed['ruleId'] as string) : undefined,
        generatedAt:
          typeof parsed['generatedAt'] === 'string' ? (parsed['generatedAt'] as string) : new Date().toISOString(),
        status,
        findings,
        metadata: (parsed['metadata'] as Record<string, unknown>) ?? undefined,
      },
    };
  }
  // Text fallback: every non-empty line becomes a finding.
  const findings: ICustomCheckFinding[] = trimmed
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => ({ severity: 'warning' as const, message: l }));
  return {
    ok: true,
    report: {
      schema: CUSTOM_CHECK_REPORT_SCHEMA,
      checkId: expectedCheckId ?? '(text)',
      generatedAt: new Date().toISOString(),
      status: findings.length > 0 ? CustomCheckStatus.Warn : CustomCheckStatus.Pass,
      findings,
    },
  };
}

export interface IRunCustomCheckOptions {
  cwd: string;
  /** When false (default) the runner prints the command and exits without spawning. */
  execute?: boolean;
  /** Override the descriptor reportPath. */
  reportPath?: string;
  /** Optional environment additions. */
  env?: Record<string, string>;
  /** Maximum runtime in ms. */
  timeoutMs?: number;
}

export interface IRunCustomCheckResult {
  schema: 'sharkcraft.custom-check-run/v1';
  checkId: string;
  ownerRuleId?: string;
  command: string;
  executed: boolean;
  exitCode: number | null;
  stderr?: string;
  stdoutSummary?: string;
  report?: ICustomCheckReport;
  reason?: string;
}

export function runCustomCheck(
  descriptor: ICustomCheckDescriptor,
  options: IRunCustomCheckOptions,
): IRunCustomCheckResult {
  const result: IRunCustomCheckResult = {
    schema: 'sharkcraft.custom-check-run/v1',
    checkId: descriptor.id,
    ownerRuleId: descriptor.ownerRuleId,
    command: descriptor.command,
    executed: false,
    exitCode: null,
  };
  if (!options.execute) {
    result.reason = 'execute flag not set; printing command only';
    return result;
  }
  const child = spawnSync(descriptor.command, {
    cwd: options.cwd,
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env ?? {}) },
    timeout: options.timeoutMs ?? 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  result.executed = true;
  result.exitCode = child.status ?? null;
  if (child.stderr) result.stderr = String(child.stderr).slice(0, 4_000);
  if (child.stdout) result.stdoutSummary = String(child.stdout).slice(0, 4_000);
  const reportPath = options.reportPath ?? descriptor.reportPath;
  if (reportPath) {
    const abs = nodePath.isAbsolute(reportPath) ? reportPath : nodePath.resolve(options.cwd, reportPath);
    const parsed = parseCustomCheckReportFromFile(abs, descriptor.id);
    if (parsed.ok) result.report = parsed.report;
    else result.reason = `parse failed: ${parsed.reason}`;
  }
  return result;
}
