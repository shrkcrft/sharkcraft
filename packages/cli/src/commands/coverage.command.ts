import {
  buildCoverageReport,
  buildScaffoldCoverageReport,
  inspectSharkcraft,
  renderScaffoldCoverageMarkdown,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';

export const coverageCommand: ICommandHandler = {
  name: 'coverage',
  description:
    'Report relationship/coverage quality across registries + scaffold coverage (`shrk coverage scaffolds --task "<task>"`).',
  usage:
    'shrk [--cwd <dir>] coverage [--json]\n  shrk [--cwd <dir>] coverage scaffolds [--task "<task>"|--domain <domain>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    if (args.positional[0] === 'scaffolds') {
      const sliced: ParsedArgs = { ...args, positional: args.positional.slice(1) };
      return runCoverageScaffolds(sliced);
    }
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const report = buildCoverageReport(inspection);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(report) + '\n');
      return 0;
    }
    process.stdout.write(header('Coverage report'));
    process.stdout.write(kv('overall', `${report.overall}/100`) + '\n\n');
    for (const c of report.categories) {
      process.stdout.write(
        `  ${c.score.toString().padStart(3)}/100  ${c.title.padEnd(48)} (${c.covered}/${c.total})\n`,
      );
      for (const m of c.missing.slice(0, 5)) process.stdout.write(`           - ${m}\n`);
      if (c.missing.length > 5) {
        process.stdout.write(`           - … (${c.missing.length - 5} more)\n`);
      }
    }
    if (report.suggestions.length) {
      process.stdout.write('\nSuggestions:\n');
      for (const s of report.suggestions) process.stdout.write(`  • ${s}\n`);
    }
    return 0;
  },
};

async function runCoverageScaffolds(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const task = flagString(args, 'task');
  const domain = flagString(args, 'domain');
  if (!task && !domain) {
    process.stderr.write(
      'Usage: shrk coverage scaffolds --task "<task>" | --domain <domain> [--json]\n',
    );
    return 2;
  }
  const inspection = await inspectSharkcraft({ cwd });
  const report = await buildScaffoldCoverageReport(inspection, {
    ...(task ? { task } : {}),
    ...(domain ? { domain } : {}),
  });
  if (flagBool(args, 'json')) {
    process.stdout.write(asJson(report) + '\n');
    return report.grade === 'missing' ? 1 : 0;
  }
  process.stdout.write(renderScaffoldCoverageMarkdown(report));
  return report.grade === 'missing' ? 1 : 0;
}
