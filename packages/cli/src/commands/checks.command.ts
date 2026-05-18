/**
 * `shrk checks` (custom-check registry CLI).
 *
 * Read-only inventory + descriptor doctor + opt-in run dispatcher for the
 * deterministic project scripts that rules attach via `metadata.checks[]`.
 *
 * Hard rules:
 *   - `shrk checks list` and `shrk checks doctor` never spawn a process.
 *   - `shrk checks run <id>` never spawns by default; pass `--execute`
 *     to actually run the script.
 *   - The engine never mutates source — even when --execute is set,
 *     responsibility for what the script does is the script's.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildCheckAggregate,
  buildCheckResult,
  buildCustomChecksRegistry,
  CHECK_AGGREGATE_SCHEMA,
  CHECK_RESULT_SCHEMA,
  CheckResultStatus,
  convertBiomeToCheckResult,
  convertEslintToCheckResult,
  CustomCheckScope,
  doctorCustomChecks,
  inspectSharkcraft,
  parseCheckResult,
  parseCheckResultFromFile,
  parseCustomCheckReportFromFile,
  runCustomCheck,
  type ICheckResult,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';

const CHECKS_DIR_REL = '.sharkcraft/checks';

export const checksListCommand: ICommandHandler = {
  name: 'list',
  description: 'List custom checks declared by rules (metadata.checks[]). Read-only.',
  usage: 'shrk checks list [--rule <ruleId>] [--kind <k>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const registry = buildCustomChecksRegistry(inspection.knowledgeEntries);
    const ruleFilter = flagString(args, 'rule');
    const kindFilter = flagString(args, 'kind');
    let entries = registry.entries;
    if (ruleFilter) entries = entries.filter((e) => e.ruleId === ruleFilter);
    if (kindFilter) entries = entries.filter((e) => e.descriptor.kind === kindFilter);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ ...registry, entries }) + '\n');
      return 0;
    }
    process.stdout.write(header(`Custom checks (${entries.length})`));
    if (entries.length === 0) {
      process.stdout.write('  (no checks declared — add metadata.checks[] to a rule)\n');
      return 0;
    }
    for (const e of entries) {
      const d = e.descriptor;
      process.stdout.write(`  ${d.id}\n`);
      process.stdout.write(`    rule:    ${e.ruleId}\n`);
      process.stdout.write(`    kind:    ${d.kind ?? '(unset)'}\n`);
      process.stdout.write(`    safety:  ${d.safety ?? '(unset)'}\n`);
      process.stdout.write(`    scope:   ${d.scope ?? CustomCheckScope.All}\n`);
      process.stdout.write(`    output:  ${d.output ?? '(exit-code)'}\n`);
      process.stdout.write(`    command: ${d.command}\n`);
      if (d.reportPath) process.stdout.write(`    report:  ${d.reportPath}\n`);
      if (d.description) process.stdout.write(`    desc:    ${d.description}\n`);
      if (e.warnings.length > 0) {
        for (const w of e.warnings) process.stdout.write(`    warn:    ${w}\n`);
      }
    }
    if (registry.duplicates.length > 0) {
      process.stdout.write('\n  duplicates:\n');
      for (const d of registry.duplicates) {
        process.stdout.write(`    ${d.id}: ${d.ruleIds.join(', ')}\n`);
      }
    }
    return 0;
  },
};

export const checksDoctorCommand: ICommandHandler = {
  name: 'doctor',
  description: 'Validate custom-check descriptors. Reports missing fields, duplicate ids, etc.',
  usage: 'shrk checks doctor [--json] [--strict]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const registry = buildCustomChecksRegistry(inspection.knowledgeEntries);
    const report = doctorCustomChecks(registry);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(report) + '\n');
    } else {
      process.stdout.write(header('Custom checks doctor'));
      process.stdout.write(`  total      ${report.totalChecks}\n`);
      process.stdout.write(`  errors     ${report.errors}\n`);
      process.stdout.write(`  warnings   ${report.warnings}\n`);
      if (report.details.length === 0) {
        process.stdout.write('\nNo descriptor issues. ✓\n');
      } else {
        process.stdout.write('\nDetails:\n');
        for (const d of report.details) {
          process.stdout.write(
            `  ${d.severity.padEnd(7)} [${d.checkId}] (${d.ruleId}) — ${d.message}\n`,
          );
        }
      }
    }
    if (report.errors > 0) return 1;
    if (flagBool(args, 'strict') && report.warnings > 0) return 1;
    return 0;
  },
};

export const checksRunCommand: ICommandHandler = {
  name: 'run',
  description:
    'Run a custom check. Read-only by default — pass --execute to actually invoke the command.',
  usage:
    'shrk checks run <checkId> [--execute] [--report-path <path>] [--changed-only|--staged|--all] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const checkId = args.positional[0];
    if (!checkId) {
      process.stderr.write('Usage: shrk checks run <checkId> [--execute]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const registry = buildCustomChecksRegistry(inspection.knowledgeEntries);
    const entry = registry.entries.find((e) => e.descriptor.id === checkId);
    if (!entry) {
      process.stderr.write(`No custom check with id "${checkId}".\n`);
      return 1;
    }
    const result = runCustomCheck(entry.descriptor, {
      cwd,
      execute: flagBool(args, 'execute'),
      reportPath: flagString(args, 'report-path') ?? undefined,
    });
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(result) + '\n');
    } else {
      process.stdout.write(header(`Custom check: ${checkId}`));
      process.stdout.write(`  rule:     ${entry.ruleId}\n`);
      process.stdout.write(`  command:  ${result.command}\n`);
      process.stdout.write(`  executed: ${result.executed}\n`);
      if (result.exitCode !== null) process.stdout.write(`  exitCode: ${result.exitCode}\n`);
      if (result.reason) process.stdout.write(`  note:     ${result.reason}\n`);
      if (result.report) {
        process.stdout.write(`  status:   ${result.report.status}\n`);
        process.stdout.write(`  findings: ${result.report.findings.length}\n`);
        for (const f of result.report.findings.slice(0, 10)) {
          process.stdout.write(`    [${f.severity}] ${f.file ?? ''} ${f.message}\n`);
        }
      }
      if (!flagBool(args, 'execute')) {
        process.stdout.write('\n  (preview — pass --execute to run the script)\n');
      }
    }
    if (result.executed && (result.exitCode ?? 0) !== 0) return 1;
    return 0;
  },
};

export const checksParseReportCommand: ICommandHandler = {
  name: 'parse-report',
  description:
    'Parse a sharkcraft.custom-check/v1 JSON report file (or text fallback) and validate its shape.',
  usage: 'shrk checks parse-report <path> [--check-id <id>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const path = args.positional[0];
    if (!path) {
      process.stderr.write('Usage: shrk checks parse-report <path>\n');
      return 2;
    }
    const checkId = flagString(args, 'check-id') ?? undefined;
    const parsed = parseCustomCheckReportFromFile(path, checkId);
    if (!parsed.ok) {
      if (flagBool(args, 'json')) {
        process.stdout.write(asJson({ ok: false, reason: parsed.reason }) + '\n');
      } else {
        process.stderr.write(`Parse failed: ${parsed.reason}\n`);
      }
      return 1;
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ ok: true, report: parsed.report }) + '\n');
    } else {
      const r = parsed.report;
      process.stdout.write(header(`Custom-check report: ${r.checkId}`));
      process.stdout.write(`  status:   ${r.status}\n`);
      process.stdout.write(`  findings: ${r.findings.length}\n`);
      for (const f of r.findings.slice(0, 20)) {
        process.stdout.write(`    [${f.severity}] ${f.file ?? ''} ${f.message}\n`);
      }
    }
    return 0;
  },
};

// ── Universal check-result protocol ────────────────────────────────

function checksDir(cwd: string): string {
  return nodePath.join(cwd, CHECKS_DIR_REL);
}

function ensureChecksDir(cwd: string): string {
  const dir = checksDir(cwd);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function safeSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'imported';
}

function writeCheckResult(cwd: string, result: ICheckResult, suggestedSlug: string): string {
  const dir = ensureChecksDir(cwd);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `${ts}-${safeSlug(suggestedSlug)}.json`;
  const abs = nodePath.join(dir, name);
  writeFileSync(abs, JSON.stringify(result, null, 2) + '\n', 'utf8');
  return abs;
}

function listImportedResults(cwd: string): { path: string; raw: string }[] {
  const dir = checksDir(cwd);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => nodePath.join(dir, f))
    .map((p) => ({ path: p, raw: readFileSync(p, 'utf8') }));
}

/**
 * `shrk checks import <file>`. Read a v1 report, or convert a
 * known third-party format (ESLint JSON for now), and store the
 * canonical result under `.sharkcraft/checks/`.
 */
export const checksImportCommand: ICommandHandler = {
  name: 'import',
  description:
    'Import a sharkcraft.check-result/v1 JSON file (or auto-convert from ESLint JSON) and store it under .sharkcraft/checks/.',
  usage:
    'shrk checks import <file> [--tool <name>] [--as eslint|biome|v1] [--json] [--dry-run]',
  async run(args: ParsedArgs): Promise<number> {
    const file = args.positional[0];
    if (!file) {
      process.stderr.write('Usage: shrk checks import <file> [--as eslint|biome|v1]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const abs = nodePath.isAbsolute(file) ? file : nodePath.join(cwd, file);
    if (!existsSync(abs)) {
      process.stderr.write(`File not found: ${abs}\n`);
      return 1;
    }
    const raw = readFileSync(abs, 'utf8');
    const asHint = flagString(args, 'as') ?? autoDetectFormat(raw);
    let parsed: ReturnType<typeof parseCheckResult>;
    if (asHint === 'eslint') parsed = convertEslintToCheckResult(raw, abs);
    else if (asHint === 'biome') parsed = convertBiomeToCheckResult(raw, abs);
    else parsed = parseCheckResult(raw);
    if (!parsed.ok) {
      process.stderr.write(`Could not parse "${abs}" as ${asHint}: ${parsed.reason}\n`);
      return 1;
    }
    const toolOverride = flagString(args, 'tool');
    const result: ICheckResult = toolOverride
      ? { ...parsed.result, tool: toolOverride }
      : parsed.result;
    const slug = safeSlug(`${result.tool}-${nodePath.basename(abs, nodePath.extname(abs))}`);
    if (flagBool(args, 'dry-run')) {
      if (flagBool(args, 'json')) {
        process.stdout.write(asJson({ mode: 'dry-run', result }) + '\n');
        return 0;
      }
      process.stdout.write(header('Imported (dry-run)'));
      process.stdout.write(`  tool:     ${result.tool}\n`);
      process.stdout.write(`  status:   ${result.status}\n`);
      process.stdout.write(
        `  findings: ${result.summary.total} (${result.summary.errors}E / ${result.summary.warnings}W / ${result.summary.infos}I)\n`,
      );
      process.stdout.write('\nRe-run without --dry-run to store under .sharkcraft/checks/.\n');
      return 0;
    }
    const written = writeCheckResult(cwd, result, slug);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ mode: 'write', path: written, result }) + '\n');
    } else {
      process.stdout.write(header('Check result imported'));
      process.stdout.write(`  tool:     ${result.tool}\n`);
      process.stdout.write(`  status:   ${result.status}\n`);
      process.stdout.write(
        `  findings: ${result.summary.total} (${result.summary.errors}E / ${result.summary.warnings}W / ${result.summary.infos}I)\n`,
      );
      process.stdout.write(`  stored:   ${written}\n`);
      process.stdout.write('\nNext: `shrk checks aggregate` to roll up everything in .sharkcraft/checks/.\n');
    }
    return result.status === CheckResultStatus.Fail ? 1 : 0;
  },
};

function autoDetectFormat(raw: string): 'eslint' | 'biome' | 'v1' {
  // Cheap sniff — avoid full parse just to classify.
  if (raw.includes('sharkcraft.check-result/v1')) return 'v1';
  if (/"messages"\s*:/.test(raw) && /"errorCount"\s*:/.test(raw)) return 'eslint';
  if (/"diagnostics"\s*:/.test(raw)) return 'biome';
  return 'v1';
}

/**
 * `shrk checks aggregate`. Read every v1 result under
 * `.sharkcraft/checks/` and produce a rollup. Writes to
 * `.sharkcraft/checks/aggregate.json` unless `--no-write` is set.
 */
export const checksAggregateCommand: ICommandHandler = {
  name: 'aggregate',
  description:
    'Roll up every sharkcraft.check-result/v1 JSON file in .sharkcraft/checks/ into a single sharkcraft.check-aggregate/v1 report.',
  usage:
    'shrk checks aggregate [--no-write] [--output <path>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const files = listImportedResults(cwd);
    const aggregateName = 'aggregate.json';
    const items: { result: ICheckResult; sourceReportPath: string }[] = [];
    for (const f of files) {
      // Skip a prior aggregate so we don't roll the rollup into itself.
      if (nodePath.basename(f.path) === aggregateName) continue;
      const parsed = parseCheckResult(f.raw);
      if (!parsed.ok) continue;
      items.push({ result: parsed.result, sourceReportPath: f.path });
    }
    const aggregate = buildCheckAggregate(items);
    const wantJson = flagBool(args, 'json');
    if (!flagBool(args, 'no-write')) {
      const dir = ensureChecksDir(cwd);
      const explicitOut = flagString(args, 'output');
      const out = explicitOut
        ? nodePath.isAbsolute(explicitOut)
          ? explicitOut
          : nodePath.join(cwd, explicitOut)
        : nodePath.join(dir, aggregateName);
      mkdirSync(nodePath.dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify(aggregate, null, 2) + '\n', 'utf8');
      if (wantJson) {
        process.stdout.write(asJson({ path: out, aggregate }) + '\n');
      } else {
        renderAggregateText(aggregate, out);
      }
    } else if (wantJson) {
      process.stdout.write(asJson(aggregate) + '\n');
    } else {
      renderAggregateText(aggregate, null);
    }
    return aggregate.overall === CheckResultStatus.Fail ? 1 : 0;
  },
};

function renderAggregateText(
  aggregate: { overall: string; total: { errors: number; warnings: number; infos: number; total: number }; entries: readonly { tool: string; status: string; summary: { errors: number; warnings: number; infos: number }; sourceReportPath: string }[] },
  writtenPath: string | null,
): void {
  process.stdout.write(header(`Check aggregate (${aggregate.overall})`));
  process.stdout.write(
    `  total findings  ${aggregate.total.total} (${aggregate.total.errors}E / ${aggregate.total.warnings}W / ${aggregate.total.infos}I)\n\n`,
  );
  if (aggregate.entries.length === 0) {
    process.stdout.write('  No imported results in .sharkcraft/checks/ yet.\n');
    process.stdout.write('  Use `shrk checks import <file>` to add one.\n');
  } else {
    for (const e of aggregate.entries) {
      process.stdout.write(
        `  ${e.status.padEnd(7)} ${e.tool.padEnd(14)} ${e.summary.errors}E / ${e.summary.warnings}W / ${e.summary.infos}I  ← ${e.sourceReportPath}\n`,
      );
    }
  }
  if (writtenPath) {
    process.stdout.write(`\nWrote ${writtenPath}\n`);
  }
}

/**
 * `shrk checks report`. Render the aggregate (or each individual
 * imported result if no aggregate exists yet) as text / markdown / json.
 */
export const checksReportCommand: ICommandHandler = {
  name: 'report',
  description:
    'Render the .sharkcraft/checks/ aggregate (or every individual result) as text / markdown / json.',
  usage:
    'shrk checks report [--format text|markdown|json] [--output <path>]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const files = listImportedResults(cwd);
    const aggregateName = 'aggregate.json';
    const aggregateFile = files.find((f) => nodePath.basename(f.path) === aggregateName);
    const format = (flagString(args, 'format') ?? 'text').toLowerCase();
    const outputRel = flagString(args, 'output');
    let payload: string;
    if (aggregateFile) {
      const parsed = JSON.parse(aggregateFile.raw);
      if (format === 'json') payload = asJson(parsed) + '\n';
      else if (format === 'markdown') payload = renderAggregateMarkdown(parsed);
      else payload = renderAggregateAsText(parsed);
    } else {
      const items = files
        .map((f) => parseCheckResult(f.raw))
        .filter((p) => p.ok)
        .map((p) => (p as { ok: true; result: ICheckResult }).result);
      if (format === 'json') payload = asJson({ results: items }) + '\n';
      else if (format === 'markdown') payload = renderResultsMarkdown(items);
      else payload = renderResultsText(items);
    }
    if (outputRel) {
      const outputAbs = nodePath.isAbsolute(outputRel) ? outputRel : nodePath.join(cwd, outputRel);
      mkdirSync(nodePath.dirname(outputAbs), { recursive: true });
      writeFileSync(outputAbs, payload, 'utf8');
      process.stdout.write(`Wrote ${outputAbs}\n`);
    } else {
      process.stdout.write(payload);
    }
    return 0;
  },
};

function renderAggregateAsText(aggregate: {
  overall: string;
  total: { errors: number; warnings: number; infos: number; total: number };
  entries: readonly { tool: string; status: string; summary: { errors: number; warnings: number; infos: number }; sourceReportPath: string }[];
}): string {
  const lines: string[] = [];
  lines.push(`=== Check aggregate (${aggregate.overall}) ===`);
  lines.push(
    `  total findings  ${aggregate.total.total} (${aggregate.total.errors}E / ${aggregate.total.warnings}W / ${aggregate.total.infos}I)`,
  );
  for (const e of aggregate.entries) {
    lines.push(
      `  ${e.status.padEnd(7)} ${e.tool.padEnd(14)} ${e.summary.errors}E / ${e.summary.warnings}W / ${e.summary.infos}I  ← ${e.sourceReportPath}`,
    );
  }
  return lines.join('\n') + '\n';
}

function renderAggregateMarkdown(aggregate: {
  overall: string;
  total: { errors: number; warnings: number; infos: number; total: number };
  entries: readonly { tool: string; status: string; summary: { errors: number; warnings: number; infos: number }; sourceReportPath: string }[];
}): string {
  const lines: string[] = [];
  lines.push(`# Check aggregate — \`${aggregate.overall}\``);
  lines.push('');
  lines.push(
    `**Total findings:** ${aggregate.total.total} (${aggregate.total.errors} error / ${aggregate.total.warnings} warn / ${aggregate.total.infos} info)`,
  );
  lines.push('');
  lines.push('| Tool | Status | Errors | Warnings | Source |');
  lines.push('|---|---|---:|---:|---|');
  for (const e of aggregate.entries) {
    lines.push(
      `| \`${e.tool}\` | ${e.status} | ${e.summary.errors} | ${e.summary.warnings} | \`${e.sourceReportPath}\` |`,
    );
  }
  return lines.join('\n') + '\n';
}

function renderResultsText(results: readonly ICheckResult[]): string {
  const lines: string[] = [];
  lines.push(`=== Imported check results (${results.length}) ===`);
  if (results.length === 0) {
    lines.push('  (none — run `shrk checks import <file>` first)');
  }
  for (const r of results) {
    lines.push(
      `  ${r.status.padEnd(7)} ${r.tool.padEnd(14)} ${r.summary.errors}E / ${r.summary.warnings}W / ${r.summary.infos}I`,
    );
  }
  return lines.join('\n') + '\n';
}

function renderResultsMarkdown(results: readonly ICheckResult[]): string {
  const lines: string[] = [];
  lines.push(`# Imported check results (${results.length})`);
  lines.push('');
  if (results.length === 0) {
    lines.push('_(none — run `shrk checks import <file>` first)_');
    return lines.join('\n') + '\n';
  }
  lines.push('| Tool | Status | Errors | Warnings | Info |');
  lines.push('|---|---|---:|---:|---:|');
  for (const r of results) {
    lines.push(
      `| \`${r.tool}\` | ${r.status} | ${r.summary.errors} | ${r.summary.warnings} | ${r.summary.infos} |`,
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * `shrk checks convert <eslint|biome> <file>`. One-shot
 * conversion from a third-party format to a v1 check-result. Writes
 * to stdout unless `--output` is set.
 */
export const checksConvertCommand: ICommandHandler = {
  name: 'convert',
  description:
    'Convert a third-party check report (eslint, biome) into a sharkcraft.check-result/v1 JSON. Prints to stdout by default; `--output <path>` writes to disk.',
  usage:
    'shrk checks convert <eslint|biome> <file> [--output <path>] [--store]',
  async run(args: ParsedArgs): Promise<number> {
    const format = args.positional[0];
    const file = args.positional[1];
    if (!format || !file) {
      process.stderr.write('Usage: shrk checks convert <eslint|biome> <file>\n');
      return 2;
    }
    if (format !== 'eslint' && format !== 'biome') {
      process.stderr.write(`Unsupported format "${format}". Use eslint or biome.\n`);
      return 2;
    }
    const cwd = resolveCwd(args);
    const abs = nodePath.isAbsolute(file) ? file : nodePath.join(cwd, file);
    if (!existsSync(abs)) {
      process.stderr.write(`File not found: ${abs}\n`);
      return 1;
    }
    const raw = readFileSync(abs, 'utf8');
    const converter = format === 'eslint' ? convertEslintToCheckResult : convertBiomeToCheckResult;
    const parsed = converter(raw, abs);
    if (!parsed.ok) {
      process.stderr.write(`Convert failed: ${parsed.reason}\n`);
      return 1;
    }
    const text = JSON.stringify(parsed.result, null, 2) + '\n';
    const outputRel = flagString(args, 'output');
    if (outputRel) {
      const outputAbs = nodePath.isAbsolute(outputRel) ? outputRel : nodePath.join(cwd, outputRel);
      mkdirSync(nodePath.dirname(outputAbs), { recursive: true });
      writeFileSync(outputAbs, text, 'utf8');
      process.stdout.write(`Wrote ${outputAbs}\n`);
    } else if (flagBool(args, 'store')) {
      const stored = writeCheckResult(cwd, parsed.result, `${format}-${nodePath.basename(abs)}`);
      process.stdout.write(`Stored ${stored}\n`);
    } else {
      process.stdout.write(text);
    }
    return parsed.result.status === CheckResultStatus.Fail ? 1 : 0;
  },
};

// Make schema constants discoverable from build tooling without
// pulling them through inspector exports a second time.
void CHECK_RESULT_SCHEMA;
void CHECK_AGGREGATE_SCHEMA;
void buildCheckResult;
