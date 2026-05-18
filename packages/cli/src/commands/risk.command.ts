import {
  buildTaskRiskReport,
  inspectSharkcraft,
  renderTaskRiskMarkdown,
  renderTaskRiskText,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';

function parseFilesFlag(args: ParsedArgs): string[] {
  const raw = flagString(args, 'files');
  if (!raw) return [];
  return raw
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
}

export const riskCommand: ICommandHandler = {
  name: 'risk',
  description: 'Compute a per-task risk report (intent + impact + architecture + boundaries + ownership + tests).',
  usage:
    'shrk risk "<task>" [--files a,b,c] [--since <ref>] [--staged] [--json] [--explain] [--format text|markdown|json]',
  async run(args: ParsedArgs): Promise<number> {
    const task = args.positional.join(' ').trim();
    if (!task) {
      process.stderr.write('Usage: shrk risk "<task>"\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const files = parseFilesFlag(args);
    const since = flagString(args, 'since');
    const staged = flagBool(args, 'staged');
    const includeMemory = flagBool(args, 'include-memory');
    const report = await buildTaskRiskReport(task, inspection, {
      ...(files.length > 0 ? { files } : {}),
      ...(since ? { since } : {}),
      ...(staged ? { staged: true } : {}),
      ...(includeMemory ? { includeMemory: true } : {}),
    });
    const format = (flagString(args, 'format') ?? '').toLowerCase();
    if (flagBool(args, 'json') || format === 'json') {
      process.stdout.write(asJson(report) + '\n');
      return 0;
    }
    if (format === 'markdown') {
      process.stdout.write(renderTaskRiskMarkdown(report));
      return 0;
    }
    process.stdout.write(renderTaskRiskText(report));
    if (flagBool(args, 'explain')) {
      process.stdout.write('\nExplanation:\n');
      process.stdout.write(
        `  Score ${report.score} → ${report.riskLevel}; ` +
          (report.humanApprovalRequired ? 'human approval required.' : 'human approval optional.') +
          '\n',
      );
      for (const r of report.reasons) {
        process.stdout.write(`  • ${r.code}: ${r.message} (+${r.weight})\n`);
      }
    }
    return 0;
  },
};
