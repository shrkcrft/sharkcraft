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
 * WHAT IS SCANNED: `type: 'rule'` entries ({@link isRuleEntry} — the same set
 * `shrk rules list` shows) loaded from TypeScript knowledge / rule files, local
 * or pack. A declaration anywhere else is REPORTED, never silently skipped:
 *   - `metadata.checks` on a non-rule entry → `ignored`;
 *   - a Markdown rule whose frontmatter held `metadata` (the Markdown loader
 *     does not read it) → `ignored`;
 *   - a non-array `metadata.checks` on a rule → `invalid`.
 * Each is a declared check that can never run — a doctor error.
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
import { type IKnowledgeEntry, unsupportedFrontmatterKeys } from '@shrkcrft/knowledge';
import { isRuleEntry } from '@shrkcrft/rules';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

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

/** A `metadata.checks` declaration the registry found but does not register — it can never run. */
export interface ICustomCheckIgnoredDeclaration {
  /** The entry that declared it. */
  entryId: string;
  /** Its knowledge `type` (`'rule'` only for a Markdown rule whose metadata the loader dropped). */
  entryType: string;
  /** The declaring file, project-relative when the root is known. */
  source?: string;
  /** Why it is not registered, and what to do instead. */
  reason: string;
  /** The check ids it declared, when readable — `checks run <id>` names where they went. */
  checkIds: readonly string[];
}

export interface ICustomCheckRegistry {
  schema: typeof CUSTOM_CHECKS_REGISTRY_SCHEMA;
  generatedAt: string;
  entries: readonly ICustomCheckRegistryEntry[];
  duplicates: readonly { id: string; ruleIds: readonly string[] }[];
  /** Declared on a rule, but unusable (no id, no command, a non-array `metadata.checks`). */
  invalid: readonly { ruleId: string; reason: string; source?: string; checkId?: string }[];
  /** Declared where the registry does not read (a non-rule entry, a Markdown rule). */
  ignored: readonly ICustomCheckIgnoredDeclaration[];
  /** `type: 'rule'` entries scanned — via {@link isRuleEntry}, the set `shrk rules list` shows. */
  scannedRules: number;
}

/** The inspection-free inputs of {@link buildCustomChecksRegistry}. */
export interface IBuildCustomChecksOptions {
  /** Makes each declaration's `source` project-relative. */
  readonly projectRoot?: string;
}

const ID_RE = /^[a-z][a-z0-9.-]+$/;
const TS_SOURCE_RE = /\.(?:ts|tsx|js|mjs|cjs)$/;

/** Read the descriptors a rule declares under `metadata.checks`. */
export function readDescriptorsFromRule(rule: IKnowledgeEntry): readonly ICustomCheckDescriptor[] {
  const md = rule.metadata as Record<string, unknown> | undefined;
  const raw = md?.['checks'];
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => ({ ...(r as ICustomCheckDescriptor), ownerRuleId: rule.id }));
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** The string ids of a declared `metadata.checks` value (whatever its shape). */
function declaredCheckIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    const id = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined;
    return typeof id === 'string' ? [id] : [];
  }
  return raw
    .map((d) => (d && typeof d === 'object' ? (d as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === 'string');
}

function relativeSource(origin: string | undefined, projectRoot: string | undefined): string | undefined {
  if (!origin) return undefined;
  if (!projectRoot || !nodePath.isAbsolute(origin)) return origin;
  return nodePath.relative(projectRoot, origin).split(nodePath.sep).join('/');
}

/**
 * Did this Markdown file's frontmatter declare `metadata` holding `checks`?
 * Read through the Markdown loader's own "what did I drop" authority.
 */
function markdownDroppedChecks(origin: string | undefined): boolean {
  if (!origin || !existsSync(origin)) return false;
  let text: string;
  try {
    text = readFileSync(origin, 'utf8');
  } catch {
    return false;
  }
  return unsupportedFrontmatterKeys(text).some((k) => k.key === 'metadata' && /\bchecks\b/.test(k.block));
}

export function buildCustomChecksRegistry(
  entries: readonly IKnowledgeEntry[],
  options: IBuildCustomChecksOptions = {},
): ICustomCheckRegistry {
  const out: ICustomCheckRegistryEntry[] = [];
  const idIndex = new Map<string, string[]>();
  const invalid: { ruleId: string; reason: string; source?: string; checkId?: string }[] = [];
  const ignored: ICustomCheckIgnoredDeclaration[] = [];
  let scannedRules = 0;

  for (const e of entries) {
    const source = relativeSource(e.source?.origin, options.projectRoot);
    const at = source ? { source } : {};
    const raw = (e.metadata as Record<string, unknown> | undefined)?.['checks'];
    if (!isRuleEntry(e)) {
      if (raw !== undefined) {
        ignored.push({
          entryId: e.id,
          entryType: String(e.type),
          ...at,
          reason: `metadata.checks on a type:'${String(e.type)}' entry is not scanned — only type:'rule' entries carry checks (set type: 'rule', or move the checks onto a rule)`,
          checkIds: declaredCheckIds(raw),
        });
      }
      continue;
    }
    scannedRules += 1;
    if (e.source?.loader === 'markdown') {
      if (markdownDroppedChecks(e.source.origin)) {
        ignored.push({
          entryId: e.id,
          entryType: String(e.type),
          ...at,
          reason:
            'Markdown rule — the Markdown loader does not support metadata, so its metadata.checks were dropped; declare the rule (with its checks) in a TypeScript rule file',
          checkIds: [],
        });
      }
      continue;
    }
    if (raw === undefined) continue;
    if (!Array.isArray(raw)) {
      invalid.push({ ruleId: e.id, reason: `metadata.checks must be an array (got ${describeType(raw)})`, ...at });
      continue;
    }
    const descriptors = readDescriptorsFromRule(e);
    for (const d of descriptors) {
      const warnings: string[] = [];
      if (!d.id || typeof d.id !== 'string') {
        invalid.push({ ruleId: e.id, reason: 'check entry missing string id', ...at });
        continue;
      }
      if (!ID_RE.test(d.id)) {
        warnings.push(`id "${d.id}" should match ${ID_RE.source}`);
      }
      if (!d.command || typeof d.command !== 'string') {
        invalid.push({ ruleId: e.id, reason: `check "${d.id}" missing command`, checkId: d.id, ...at });
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
    ignored,
    scannedRules,
  };
}

/**
 * Every declaration the registry saw: registered + invalid + ignored (an
 * ignored entry whose ids are unreadable still counts as one). The `expected`
 * of the doctor's coverage — 0 means nothing was declared at all.
 */
export function declaredCustomCheckCount(registry: ICustomCheckRegistry): number {
  return (
    registry.entries.length +
    registry.invalid.length +
    registry.ignored.reduce((n, i) => n + Math.max(1, i.checkIds.length), 0)
  );
}

/** Where `metadata.checks[]` is read from — what the empty state names instead of "add it to a rule". */
export interface ICustomCheckScanSurface {
  /** Project-relative TypeScript files (that exist — what the loader reads) whose `type: 'rule'` entries are scanned. */
  readonly files: readonly { readonly file: string; readonly via: string }[];
  /** Existing Markdown files listed as knowledge / rule sources — their entries cannot carry metadata. */
  readonly markdownFiles: readonly string[];
  /** `type: 'rule'` entries that came from Markdown. */
  readonly markdownRules: number;
}

/**
 * The concrete surface the custom-checks registry scans: local `ruleFiles` /
 * `knowledgeFiles` / `docsFiles` and every valid pack's `ruleFiles` /
 * `knowledgeFiles` — split into TypeScript (scanned) and Markdown (cannot
 * carry metadata).
 */
export function customCheckScanSurface(inspection: ISharkcraftInspection): ICustomCheckScanSurface {
  const files: { file: string; via: string }[] = [];
  const markdownFiles: string[] = [];
  const add = (abs: string, via: string): void => {
    // The loaders skip a configured file that does not exist (the config's
    // default docsFiles, a stale entry) — so does the surface they read.
    if (!existsSync(abs)) return;
    const file = nodePath.relative(inspection.projectRoot, abs).split(nodePath.sep).join('/') || abs;
    if (TS_SOURCE_RE.test(abs)) files.push({ file, via });
    else if (abs.toLowerCase().endsWith('.md')) markdownFiles.push(file);
  };
  const cfg = inspection.config;
  if (cfg && inspection.sharkcraftDir) {
    for (const key of ['ruleFiles', 'knowledgeFiles', 'docsFiles'] as const) {
      for (const rel of cfg[key] ?? []) add(nodePath.resolve(inspection.sharkcraftDir, rel), key);
    }
  }
  for (const pack of inspection.packs.validPacks ?? []) {
    const c = pack.manifest?.contributions;
    for (const key of ['ruleFiles', 'knowledgeFiles'] as const) {
      for (const rel of c?.[key] ?? []) add(nodePath.resolve(pack.packageRoot, rel), `pack ${pack.packageName} ${key}`);
    }
  }
  const markdownRules = inspection.knowledgeEntries.filter(
    (e) => isRuleEntry(e) && e.source?.loader === 'markdown',
  ).length;
  return { files, markdownFiles, markdownRules };
}

export interface ICustomCheckDoctorReport {
  schema: 'sharkcraft.custom-checks-doctor/v1';
  generatedAt: string;
  totalChecks: number;
  warnings: number;
  errors: number;
  /** Declarations seen (registered + invalid + ignored) — 0 means nothing was declared. */
  declaredChecks: number;
  /** Declarations that can never run because the registry does not read them. */
  ignored: number;
  /** `type: 'rule'` entries scanned. */
  scannedRules: number;
  details: readonly {
    ruleId: string;
    checkId: string;
    severity: 'error' | 'warning' | 'info';
    message: string;
    /** The declaring file, when known. */
    source?: string;
  }[];
}

export function doctorCustomChecks(
  registry: ICustomCheckRegistry,
): ICustomCheckDoctorReport {
  const details: ICustomCheckDoctorReport['details'][number][] = [];
  for (const inv of registry.invalid) {
    details.push({
      ruleId: inv.ruleId,
      checkId: inv.checkId ?? '(invalid)',
      severity: 'error',
      message: inv.reason,
      ...(inv.source ? { source: inv.source } : {}),
    });
  }
  // A declared check that can never run is a defect, not a footnote.
  for (const ig of registry.ignored) {
    details.push({
      ruleId: ig.entryId,
      checkId: ig.checkIds.join(',') || '(ignored)',
      severity: 'error',
      message: ig.reason,
      ...(ig.source ? { source: ig.source } : {}),
    });
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
    declaredChecks: declaredCustomCheckCount(registry),
    ignored: registry.ignored.length,
    scannedRules: registry.scannedRules,
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
