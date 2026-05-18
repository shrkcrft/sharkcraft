/**
 * Universal check-result protocol (`sharkcraft.check-result/v1`).
 *
 * A single schema any tool can emit so SharkCraft can aggregate
 * results from itself + ESLint + Biome + custom project checks into
 * one rollup. Distinct from `sharkcraft.custom-check/v1` (which is
 * descriptor-driven, one-check-at-a-time).
 *
 * Design rules (from feature_47.md):
 *   - status: pass | warn | fail | unknown.
 *   - findings carry severity / file / optional line/column / ruleId /
 *     message / suggestedAction / safeToAutoFix.
 *   - schema string + tool + command + generatedAt + sourceReportPath
 *     stay alongside so reproducibility is not lost.
 *   - Conversion is round-trippable but not lossy: ESLint's `endLine`
 *     / `endColumn` etc. live under `metadata` so they survive the
 *     trip without bloating the canonical shape.
 *
 * This module is pure and read-only. No spawning, no writes — the CLI
 * surface (`shrk checks import/aggregate/report/convert`) handles I/O.
 */
import { readFileSync, existsSync } from 'node:fs';

export const CHECK_RESULT_SCHEMA = 'sharkcraft.check-result/v1';
export const CHECK_AGGREGATE_SCHEMA = 'sharkcraft.check-aggregate/v1';

export enum CheckResultStatus {
  Pass = 'pass',
  Warn = 'warn',
  Fail = 'fail',
  Unknown = 'unknown',
}

export enum CheckFindingSeverity {
  Error = 'error',
  Warning = 'warning',
  Info = 'info',
}

export interface ICheckFinding {
  severity: CheckFindingSeverity;
  file?: string;
  line?: number;
  column?: number;
  ruleId?: string;
  message: string;
  suggestedAction?: string;
  safeToAutoFix?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ICheckResultSummary {
  errors: number;
  warnings: number;
  infos: number;
  total: number;
}

export interface ICheckResult {
  schema: typeof CHECK_RESULT_SCHEMA;
  tool: string;
  command?: string;
  generatedAt: string;
  status: CheckResultStatus;
  findings: readonly ICheckFinding[];
  summary: ICheckResultSummary;
  metadata?: Record<string, unknown>;
  sourceReportPath?: string;
}

export interface IParseResultOk {
  ok: true;
  result: ICheckResult;
}

export interface IParseResultErr {
  ok: false;
  reason: string;
}

export type ParseCheckResult = IParseResultOk | IParseResultErr;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function severityFromUnknown(raw: unknown): CheckFindingSeverity {
  if (raw === 2 || raw === 'error' || raw === 'fatal') return CheckFindingSeverity.Error;
  if (raw === 1 || raw === 'warning' || raw === 'warn') return CheckFindingSeverity.Warning;
  return CheckFindingSeverity.Info;
}

function summarize(findings: readonly ICheckFinding[]): ICheckResultSummary {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const f of findings) {
    if (f.severity === CheckFindingSeverity.Error) errors += 1;
    else if (f.severity === CheckFindingSeverity.Warning) warnings += 1;
    else infos += 1;
  }
  return { errors, warnings, infos, total: findings.length };
}

function statusFor(summary: ICheckResultSummary): CheckResultStatus {
  if (summary.errors > 0) return CheckResultStatus.Fail;
  if (summary.warnings > 0) return CheckResultStatus.Warn;
  return CheckResultStatus.Pass;
}

export interface IBuildCheckResultInput {
  tool: string;
  command?: string;
  findings: readonly ICheckFinding[];
  sourceReportPath?: string;
  metadata?: Record<string, unknown>;
  /** Force a specific status (overrides the auto-derived one). */
  status?: CheckResultStatus;
}

export function buildCheckResult(input: IBuildCheckResultInput): ICheckResult {
  const summary = summarize(input.findings);
  const status = input.status ?? statusFor(summary);
  const result: ICheckResult = {
    schema: CHECK_RESULT_SCHEMA,
    tool: input.tool,
    generatedAt: new Date().toISOString(),
    status,
    findings: input.findings,
    summary,
  };
  if (input.command !== undefined) result.command = input.command;
  if (input.sourceReportPath !== undefined) result.sourceReportPath = input.sourceReportPath;
  if (input.metadata !== undefined) result.metadata = input.metadata;
  return result;
}

export function parseCheckResult(raw: string): ParseCheckResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: `invalid JSON: ${(e as Error).message}` };
  }
  if (!isPlainObject(parsed)) return { ok: false, reason: 'top-level value must be an object' };
  if (parsed.schema !== CHECK_RESULT_SCHEMA) {
    return {
      ok: false,
      reason: `expected schema ${CHECK_RESULT_SCHEMA}, got ${String(parsed.schema)}`,
    };
  }
  if (typeof parsed.tool !== 'string' || parsed.tool === '') {
    return { ok: false, reason: 'missing tool string' };
  }
  if (typeof parsed.generatedAt !== 'string') {
    return { ok: false, reason: 'missing generatedAt' };
  }
  if (!Array.isArray(parsed.findings)) {
    return { ok: false, reason: 'findings must be an array' };
  }
  const findings: ICheckFinding[] = [];
  for (const rawF of parsed.findings) {
    if (!isPlainObject(rawF)) {
      return { ok: false, reason: 'finding must be an object' };
    }
    if (typeof rawF.message !== 'string' || rawF.message === '') {
      return { ok: false, reason: 'finding.message must be a non-empty string' };
    }
    const f: ICheckFinding = {
      severity: severityFromUnknown(rawF.severity),
      message: rawF.message,
    };
    if (typeof rawF.file === 'string') f.file = rawF.file;
    if (typeof rawF.line === 'number') f.line = rawF.line;
    if (typeof rawF.column === 'number') f.column = rawF.column;
    if (typeof rawF.ruleId === 'string') f.ruleId = rawF.ruleId;
    if (typeof rawF.suggestedAction === 'string') f.suggestedAction = rawF.suggestedAction;
    if (typeof rawF.safeToAutoFix === 'boolean') f.safeToAutoFix = rawF.safeToAutoFix;
    if (isPlainObject(rawF.metadata)) f.metadata = rawF.metadata;
    findings.push(f);
  }
  const summary = summarize(findings);
  const statusRaw = parsed.status;
  const status =
    statusRaw === CheckResultStatus.Pass ||
    statusRaw === CheckResultStatus.Warn ||
    statusRaw === CheckResultStatus.Fail ||
    statusRaw === CheckResultStatus.Unknown
      ? (statusRaw as CheckResultStatus)
      : statusFor(summary);
  const result: ICheckResult = {
    schema: CHECK_RESULT_SCHEMA,
    tool: parsed.tool,
    generatedAt: parsed.generatedAt,
    status,
    findings,
    summary,
  };
  if (typeof parsed.command === 'string') result.command = parsed.command;
  if (typeof parsed.sourceReportPath === 'string') {
    result.sourceReportPath = parsed.sourceReportPath;
  }
  if (isPlainObject(parsed.metadata)) result.metadata = parsed.metadata;
  return { ok: true, result };
}

export function parseCheckResultFromFile(path: string): ParseCheckResult {
  if (!existsSync(path)) return { ok: false, reason: `file not found: ${path}` };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { ok: false, reason: `read error: ${(e as Error).message}` };
  }
  return parseCheckResult(raw);
}

// ── Converters ─────────────────────────────────────────────────────────────

interface IEslintMessage {
  ruleId?: string | null;
  severity?: number;
  message?: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  fix?: unknown;
}

interface IEslintFileResult {
  filePath?: string;
  messages?: IEslintMessage[];
  errorCount?: number;
  warningCount?: number;
}

export function convertEslintToCheckResult(
  raw: string,
  sourceReportPath?: string,
): ParseCheckResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: `invalid ESLint JSON: ${(e as Error).message}` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: 'ESLint JSON must be a top-level array of file results' };
  }
  const findings: ICheckFinding[] = [];
  for (const rawFile of parsed) {
    if (!isPlainObject(rawFile)) continue;
    const file = rawFile as IEslintFileResult;
    const filePath = typeof file.filePath === 'string' ? file.filePath : undefined;
    const msgs: readonly IEslintMessage[] = Array.isArray(file.messages) ? file.messages : [];
    for (const msg of msgs) {
      if (!isPlainObject(msg)) continue;
      if (typeof msg.message !== 'string') continue;
      const f: ICheckFinding = {
        severity: severityFromUnknown(msg.severity),
        message: msg.message,
      };
      if (filePath) f.file = filePath;
      if (typeof msg.line === 'number') f.line = msg.line;
      if (typeof msg.column === 'number') f.column = msg.column;
      if (typeof msg.ruleId === 'string') f.ruleId = msg.ruleId;
      if (msg.fix !== undefined) f.safeToAutoFix = Boolean(msg.fix);
      const meta: Record<string, unknown> = {};
      if (typeof msg.endLine === 'number') meta.endLine = msg.endLine;
      if (typeof msg.endColumn === 'number') meta.endColumn = msg.endColumn;
      if (Object.keys(meta).length > 0) f.metadata = meta;
      findings.push(f);
    }
  }
  return {
    ok: true,
    result: buildCheckResult({
      tool: 'eslint',
      command: 'eslint --format json',
      findings,
      ...(sourceReportPath !== undefined ? { sourceReportPath } : {}),
    }),
  };
}

interface IBiomeDiagnostic {
  category?: string;
  severity?: string;
  description?: string;
  message?: { content?: string } | string;
  location?: { path?: { file?: string } | string; line?: number; column?: number };
}

/**
 * Biome's JSON output is not a stable contract. We accept either:
 *   - the adjacent shape: { diagnostics: [{ category, severity, description, location: { path, line?, column? } }] }
 *   - native Biome `--reporter github`-ish: { diagnostics: [{ severity, description, location }] }
 * Anything else returns a clear reason.
 */
export function convertBiomeToCheckResult(
  raw: string,
  sourceReportPath?: string,
): ParseCheckResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: `invalid Biome JSON: ${(e as Error).message}` };
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.diagnostics)) {
    return { ok: false, reason: 'expected { diagnostics: [...] } shape' };
  }
  const findings: ICheckFinding[] = [];
  for (const rawDiag of parsed.diagnostics) {
    if (!isPlainObject(rawDiag)) continue;
    const d = rawDiag as IBiomeDiagnostic;
    const message =
      typeof d.description === 'string'
        ? d.description
        : typeof d.message === 'string'
          ? d.message
          : isPlainObject(d.message) && typeof (d.message as { content?: unknown }).content === 'string'
            ? ((d.message as { content: string }).content)
            : null;
    if (!message) continue;
    const f: ICheckFinding = {
      severity: severityFromUnknown(d.severity),
      message,
    };
    if (typeof d.category === 'string') f.ruleId = d.category;
    const loc = d.location;
    if (loc) {
      if (typeof loc.path === 'string') f.file = loc.path;
      else if (isPlainObject(loc.path) && typeof (loc.path as { file?: unknown }).file === 'string') {
        f.file = (loc.path as { file: string }).file;
      }
      if (typeof loc.line === 'number') f.line = loc.line;
      if (typeof loc.column === 'number') f.column = loc.column;
    }
    findings.push(f);
  }
  return {
    ok: true,
    result: buildCheckResult({
      tool: 'biome',
      command: 'biome check --reporter json',
      findings,
      ...(sourceReportPath !== undefined ? { sourceReportPath } : {}),
    }),
  };
}

// ── Aggregation ────────────────────────────────────────────────────────────

export interface ICheckAggregateEntry {
  tool: string;
  status: CheckResultStatus;
  summary: ICheckResultSummary;
  sourceReportPath: string;
}

export interface ICheckAggregate {
  schema: typeof CHECK_AGGREGATE_SCHEMA;
  generatedAt: string;
  overall: CheckResultStatus;
  total: ICheckResultSummary;
  entries: readonly ICheckAggregateEntry[];
  /** Findings rolled up across every imported result. */
  findings: readonly ICheckFinding[];
}

function combineStatus(a: CheckResultStatus, b: CheckResultStatus): CheckResultStatus {
  // Worst wins. Fail > Warn > Pass > Unknown (Unknown only "wins" if there
  // are no other results — handled by initial accumulator).
  if (a === CheckResultStatus.Fail || b === CheckResultStatus.Fail) return CheckResultStatus.Fail;
  if (a === CheckResultStatus.Warn || b === CheckResultStatus.Warn) return CheckResultStatus.Warn;
  if (a === CheckResultStatus.Pass || b === CheckResultStatus.Pass) return CheckResultStatus.Pass;
  return CheckResultStatus.Unknown;
}

export function buildCheckAggregate(
  results: readonly { result: ICheckResult; sourceReportPath: string }[],
): ICheckAggregate {
  const findings: ICheckFinding[] = [];
  const entries: ICheckAggregateEntry[] = [];
  let overall: CheckResultStatus = CheckResultStatus.Unknown;
  const total: ICheckResultSummary = { errors: 0, warnings: 0, infos: 0, total: 0 };
  for (const item of results) {
    overall = combineStatus(overall, item.result.status);
    total.errors += item.result.summary.errors;
    total.warnings += item.result.summary.warnings;
    total.infos += item.result.summary.infos;
    total.total += item.result.summary.total;
    entries.push({
      tool: item.result.tool,
      status: item.result.status,
      summary: item.result.summary,
      sourceReportPath: item.sourceReportPath,
    });
    for (const f of item.result.findings) findings.push(f);
  }
  return {
    schema: CHECK_AGGREGATE_SCHEMA,
    generatedAt: new Date().toISOString(),
    overall,
    total,
    entries,
    findings,
  };
}
