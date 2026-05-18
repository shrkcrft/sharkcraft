import { mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildArchitectureArea,
  buildArchitectureMap,
  buildArchitectureViolations,
  buildArchitectureViolationsDiff,
  inspectSharkcraft,
  renderArchitectureMapHtml,
  renderArchitectureMapMarkdown,
  renderArchitectureMapText,
  renderArchitectureViolationsDiffHtml,
  renderArchitectureViolationsDiffMarkdown,
  renderArchitectureViolationsDiffText,
  type ArchitectureMapInclude,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  flagList,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';

const ALL_INCLUDES: readonly ArchitectureMapInclude[] = ['layers', 'constructs', 'boundaries', 'policies', 'public-api', 'tests', 'ownership'];

function parseInclude(args: ParsedArgs): readonly ArchitectureMapInclude[] {
  const raw = flagList(args, 'include');
  if (raw.length === 0) return ALL_INCLUDES;
  const flat = raw
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean) as ArchitectureMapInclude[];
  return flat.length > 0 ? flat : ALL_INCLUDES;
}

export const architectureMapCommand: ICommandHandler = {
  name: 'map',
  description:
    'Build an architecture map (layers, constructs, boundaries, public-api surfaces, tests/ownership hints, risks). Read-only.',
  usage:
    'shrk architecture map [--include layers,constructs,...] [--risk] [--signals] [--format text|markdown|html|json] [--output <file>]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const include = parseInclude(args);
    const risk = flagBool(args, 'risk');
    const signals = flagBool(args, 'signals');
    const map = await buildArchitectureMap(inspection, { include, risk, signals });
    const format = flagString(args, 'format') ?? (flagBool(args, 'json') ? 'json' : 'text');
    const output = flagString(args, 'output');
    let body = '';
    if (format === 'json') body = asJson(map) + '\n';
    else if (format === 'markdown') body = renderArchitectureMapMarkdown(map);
    else if (format === 'html') body = renderArchitectureMapHtml(map);
    else body = renderArchitectureMapText(map);
    if (output) {
      const abs = nodePath.isAbsolute(output) ? output : nodePath.resolve(cwd, output);
      mkdirSync(nodePath.dirname(abs), { recursive: true });
      writeFileSync(abs, body, 'utf8');
      process.stdout.write(`Wrote ${abs}\n`);
      return 0;
    }
    process.stdout.write(body);
    return 0;
  },
};

export const architectureViolationsCommand: ICommandHandler = {
  name: 'violations',
  description:
    'Show boundary violations as a flat report (read-only). `--since <ref>` / `--staged` / `--files a,b,c` / `--baseline <json>` scope/diff the report.',
  usage:
    'shrk architecture violations [--since <ref>] [--staged] [--files a,b,c] [--baseline <json>] [--format text|markdown|html|json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const since = flagString(args, 'since');
    const staged = flagBool(args, 'staged');
    const changedOnly = flagBool(args, 'changed-only');
    const baselineFile = flagString(args, 'baseline');
    const filesRaw = flagString(args, 'files');
    const files = filesRaw
      ? filesRaw.split(',').map((f) => f.trim()).filter((f) => f.length > 0)
      : [];
    // --changed-only is an alias that selects working-tree changes
    // (untracked + modified) when no other scope flag is provided.
    const isDiff = Boolean(since || staged || baselineFile || changedOnly) || files.length > 0;
    const format = (flagString(args, 'format') ?? '').toLowerCase();

    if (!isDiff) {
      const report = await buildArchitectureViolations(inspection);
      if (flagBool(args, 'json') || format === 'json') {
        process.stdout.write(asJson(report) + '\n');
        return report.total === 0 ? 0 : 1;
      }
      process.stdout.write(`=== Architecture violations ===\n  total ${report.total}\n`);
      if (report.byRule.length > 0) {
        process.stdout.write('By rule:\n');
        for (const r of report.byRule) process.stdout.write(`  ${String(r.count).padStart(4)}  ${r.ruleId}\n`);
      }
      for (const v of report.violations.slice(0, 30))
        process.stdout.write(`  [${v.severity}] ${v.ruleId} ${v.file}:${v.line} → ${v.importSpecifier}\n`);
      return report.total === 0 ? 0 : 1;
    }

    // When --changed-only is set without a more specific scope, pull
    // the working-tree changed files (untracked + modified) and pass through
    // the `files` channel so the diff engine treats them as the changed set.
    let resolvedFiles = files;
    if (changedOnly && !since && !staged && files.length === 0) {
      const { getChangedFiles } = await import('@shrkcrft/inspector');
      resolvedFiles = getChangedFiles(cwd, { includeWorktree: true });
    }
    const diff = await buildArchitectureViolationsDiff(inspection, {
      ...(since ? { since } : {}),
      ...(staged ? { staged: true } : {}),
      ...(baselineFile ? { baselineFile } : {}),
      ...(resolvedFiles.length > 0 ? { files: resolvedFiles } : {}),
    });
    if (flagBool(args, 'json') || format === 'json') {
      process.stdout.write(asJson(diff) + '\n');
      return diff.counts.newInChangedFile === 0 ? 0 : 1;
    }
    if (format === 'markdown') {
      process.stdout.write(renderArchitectureViolationsDiffMarkdown(diff));
      return diff.counts.newInChangedFile === 0 ? 0 : 1;
    }
    if (format === 'html') {
      process.stdout.write(renderArchitectureViolationsDiffHtml(diff));
      return diff.counts.newInChangedFile === 0 ? 0 : 1;
    }
    process.stdout.write(renderArchitectureViolationsDiffText(diff));
    return diff.counts.newInChangedFile === 0 ? 0 : 1;
  },
};

export const architectureAreaCommand: ICommandHandler = {
  name: 'area',
  description: 'Show members of an architecture area (layer id: core/foundations/asset-registries/...).',
  usage: 'shrk architecture area <areaId> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk architecture area <areaId>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const r = await buildArchitectureArea(inspection, id);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(r) + '\n');
      return r.found ? 0 : 1;
    }
    if (!r.found) {
      process.stderr.write(`Area not found: ${id}\n`);
      return 1;
    }
    process.stdout.write(`=== Area ${r.area} ===\n`);
    for (const m of r.members) process.stdout.write(`  • ${m}\n`);
    return 0;
  },
};
