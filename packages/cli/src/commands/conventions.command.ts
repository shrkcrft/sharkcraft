/**
 * `shrk conventions ...` — pack/local conventions surface.
 *
 * Read-only listing + doctor + check. `check` runs the loaded conventions
 * against caller-supplied files (or git diff). Never writes.
 */
import {
  checkConventionsAgainstFiles,
  findConvention,
  getChangedFiles,
  inspectSharkcraft,
  listConventions,
  listConventionIssues,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  flagList,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';

export const conventionsListCommand: ICommandHandler = {
  name: 'list',
  description: 'List registered conventions. Read-only.',
  usage: 'shrk conventions list [--kind <kind>] [--source local|pack] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const entries = await listConventions(inspection);
    const kind = flagString(args, 'kind');
    const source = flagString(args, 'source');
    let filtered = entries;
    if (kind) filtered = filtered.filter((e) => e.convention.kind === kind);
    if (source) filtered = filtered.filter((e) => e.source === source);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(filtered) + '\n');
      return 0;
    }
    process.stdout.write(header(`Conventions (${filtered.length})`));
    if (filtered.length === 0) {
      process.stdout.write(
        '  (none — contribute via a pack manifest "conventionFiles" entry or sharkcraft/conventions.ts)\n',
      );
      return 0;
    }
    for (const e of filtered) {
      const src = e.source === 'pack' ? `pack:${e.packageName ?? '?'}` : e.source;
      process.stdout.write(
        `  • ${e.convention.kind.padEnd(12)} ${e.convention.id.padEnd(28)} ${e.convention.title}  [${src}]\n`,
      );
    }
    return 0;
  },
};

export const conventionsGetCommand: ICommandHandler = {
  name: 'get',
  description: 'Show a single convention by id.',
  usage: 'shrk conventions get <id> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk conventions get <id>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const entry = await findConvention(inspection, id);
    if (!entry) {
      process.stderr.write(`Unknown convention "${id}".\n`);
      return 2;
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(entry) + '\n');
      return 0;
    }
    const c = entry.convention;
    process.stdout.write(header(`Convention ${c.id} (${c.kind})`));
    process.stdout.write(`  title         ${c.title}\n`);
    if (c.description) process.stdout.write(`  description   ${c.description}\n`);
    process.stdout.write(`  severity      ${c.severity}\n`);
    process.stdout.write(`  source        ${entry.source}${entry.packageName ? ' (' + entry.packageName + ')' : ''}\n`);
    process.stdout.write(`  sourceFile    ${entry.sourceFile}\n`);
    process.stdout.write(`  rules (${c.rules.length}):\n`);
    for (const r of c.rules) {
      process.stdout.write(`    • ${r.id}  ${r.description}\n`);
    }
    if (c.examples && c.examples.length > 0) {
      process.stdout.write(`  examples (${c.examples.length}):\n`);
      for (const e of c.examples) process.stdout.write(`    • ${e.description}\n`);
    }
    return 0;
  },
};

export const conventionsDoctorCommand: ICommandHandler = {
  name: 'doctor',
  description: 'Surface load/validation issues for conventions.',
  usage: 'shrk conventions doctor [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const issues = await listConventionIssues(inspection);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ issues }) + '\n');
      return issues.some((i) => i.severity === 'error') ? 1 : 0;
    }
    process.stdout.write(header('Conventions doctor'));
    if (issues.length === 0) {
      process.stdout.write('  ok — no load/validation issues.\n');
      return 0;
    }
    for (const i of issues) {
      process.stdout.write(`  ${i.severity.padEnd(7)} [${i.code}] ${i.message}\n`);
    }
    return issues.some((i) => i.severity === 'error') ? 1 : 0;
  },
};

export const conventionsCheckCommand: ICommandHandler = {
  name: 'check',
  description: 'Run loaded conventions against files (--files / --since / --staged).',
  usage:
    'shrk conventions check [--files a,b,c] [--since <ref>] [--staged] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    let files: readonly string[] = [];
    const explicit = flagList(args, 'files');
    if (explicit.length > 0) {
      files = explicit;
    } else if (flagBool(args, 'staged')) {
      files = getChangedFiles(cwd, { staged: true });
    } else {
      const since = flagString(args, 'since');
      files = since ? getChangedFiles(cwd, { since }) : getChangedFiles(cwd, {});
    }
    const report = await checkConventionsAgainstFiles(inspection, files);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(report) + '\n');
      return report.verdict === 'clean' ? 0 : 1;
    }
    process.stdout.write(header(`Convention check (${report.filesScanned} files, ${report.hits.length} hits)`));
    if (report.hits.length === 0) {
      process.stdout.write('  ok — no violations.\n');
      return 0;
    }
    for (const h of report.hits.slice(0, 200)) {
      process.stdout.write(`  ${h.severity.padEnd(7)} ${h.conventionId}/${h.ruleId} — ${h.file}\n`);
      process.stdout.write(`           ${h.message}\n`);
    }
    return report.verdict === 'clean' ? 0 : 1;
  },
};

export const conventionsExplainCommand: ICommandHandler = {
  name: 'explain',
  description: 'Explain a convention (description + rules + examples + references).',
  usage: 'shrk conventions explain <id>',
  async run(args: ParsedArgs): Promise<number> {
    return conventionsGetCommand.run(args);
  },
};

export const conventionsCommand: ICommandHandler = {
  name: 'conventions',
  description:
    'Generic conventions registry (naming / path / barrel / layout / command / validation / ownership / testing / release / safety). Read-only.',
  usage: 'shrk conventions list|get|doctor|check|explain ...',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    args.positional = args.positional.slice(1);
    if (sub === 'list') return conventionsListCommand.run(args);
    if (sub === 'get') return conventionsGetCommand.run(args);
    if (sub === 'doctor') return conventionsDoctorCommand.run(args);
    if (sub === 'check') return conventionsCheckCommand.run(args);
    if (sub === 'explain') return conventionsExplainCommand.run(args);
    process.stderr.write('Usage: shrk conventions list|get|doctor|check|explain ...\n');
    return 2;
  },
};
