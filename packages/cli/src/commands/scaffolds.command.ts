import {
  doctorScaffoldPatterns,
  inspectSharkcraft,
  loadScaffoldPatternsFromInspection,
} from '@shrkcrft/inspector';
import {
  flagBool,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';

export const scaffoldsListCommand: ICommandHandler = {
  name: 'list',
  description: 'List every scaffold pattern contributed by an installed pack.',
  usage: 'shrk scaffolds list [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const result = await loadScaffoldPatternsFromInspection(inspection);
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          patterns: result.patterns.map((p) => ({
            id: p.pattern.id,
            title: p.pattern.title,
            templateId: p.pattern.templateId,
            confidence: p.pattern.confidence,
            matchPaths: p.pattern.matchPaths,
            appliesWhen: p.pattern.appliesWhen,
            source: p.source,
          })),
          warnings: result.warnings,
        }) + '\n',
      );
      return 0;
    }
    process.stdout.write(header(`Scaffold patterns (${result.patterns.length})`));
    for (const p of result.patterns) {
      process.stdout.write(
        `  • ${p.pattern.id.padEnd(36)} ${p.pattern.confidence.padEnd(7)} → ${p.pattern.templateId}\n`,
      );
      process.stdout.write(`      ${p.pattern.title}\n`);
      process.stdout.write(`      source: ${p.source.packageName ?? p.source.type}\n`);
    }
    if (result.warnings.length > 0) {
      process.stdout.write('\nWarnings:\n');
      for (const w of result.warnings) process.stdout.write(`  ! ${w}\n`);
    }
    if (result.patterns.length === 0) {
      process.stdout.write('\nNo scaffold patterns found. Packs can contribute them via `scaffoldPatternFiles`.\n');
    }
    return 0;
  },
};

export const scaffoldsGetCommand: ICommandHandler = {
  name: 'get',
  description: 'Show one scaffold pattern (full content).',
  usage: 'shrk scaffolds get <id> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk scaffolds get <id>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const result = await loadScaffoldPatternsFromInspection(inspection);
    const match = result.patterns.find((p) => p.pattern.id === id);
    if (!match) {
      process.stderr.write(`Unknown scaffold pattern: "${id}"\n`);
      return 1;
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(match) + '\n');
      return 0;
    }
    process.stdout.write(header(`Scaffold pattern: ${match.pattern.id}`));
    process.stdout.write(kv('title', match.pattern.title) + '\n');
    process.stdout.write(kv('templateId', match.pattern.templateId) + '\n');
    process.stdout.write(kv('confidence', match.pattern.confidence) + '\n');
    process.stdout.write(kv('source', match.source.packageName ?? match.source.type) + '\n');
    process.stdout.write(`\nMatch paths:\n`);
    for (const m of match.pattern.matchPaths) process.stdout.write(`  - ${m}\n`);
    process.stdout.write(`\nApplies when:\n`);
    for (const a of match.pattern.appliesWhen) process.stdout.write(`  - ${a}\n`);
    process.stdout.write(`\nVariables:\n`);
    for (const v of match.pattern.variables) process.stdout.write(`  • ${v.name}  from=${String(v.from)}\n`);
    return 0;
  },
};

export const scaffoldsDoctorCommand: ICommandHandler = {
  name: 'doctor',
  description: 'Validate scaffold pattern definitions (templates exist, strategies recognized, …).',
  usage: 'shrk scaffolds doctor [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const result = await loadScaffoldPatternsFromInspection(inspection);
    const issues = doctorScaffoldPatterns(result.patterns, inspection);
    const errorCount = issues.filter((i) => i.severity === 'error').length;
    const warningCount = issues.filter((i) => i.severity === 'warning').length;
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          patterns: result.patterns.length,
          errors: errorCount,
          warnings: warningCount,
          issues,
          loadWarnings: result.warnings,
        }) + '\n',
      );
      return errorCount > 0 ? 1 : 0;
    }
    process.stdout.write(header('Scaffold pattern doctor'));
    process.stdout.write(kv('patterns', result.patterns.length.toString()) + '\n');
    process.stdout.write(kv('errors', errorCount.toString()) + '\n');
    process.stdout.write(kv('warnings', warningCount.toString()) + '\n');
    if (issues.length > 0) {
      process.stdout.write('\nIssues:\n');
      for (const i of issues) {
        const tag = i.severity === 'error' ? 'ERR ' : i.severity === 'warning' ? 'WARN' : 'INFO';
        process.stdout.write(`  ${tag}  ${i.patternId.padEnd(28)} ${i.field.padEnd(20)} ${i.message}\n`);
      }
    }
    if (result.warnings.length > 0) {
      process.stdout.write('\nLoad warnings:\n');
      for (const w of result.warnings) process.stdout.write(`  ! ${w}\n`);
    }
    return errorCount > 0 ? 1 : 0;
  },
};
