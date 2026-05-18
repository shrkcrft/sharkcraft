import { buildDocsCheck, renderDocsCheckText } from '@shrkcrft/inspector';
import {
  flagBool,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';

export const docsCheckCommand: ICommandHandler = {
  name: 'check',
  description: 'Verify docs/ and README content (read-only).',
  usage: 'shrk docs check [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const report = buildDocsCheck(cwd);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(report) + '\n');
      return report.ok ? 0 : 1;
    }
    process.stdout.write(renderDocsCheckText(report));
    return report.ok ? 0 : 1;
  },
};

export const examplesCheckCommand: ICommandHandler = {
  name: 'check',
  description: 'Verify examples/ tree integrity (read-only).',
  usage: 'shrk examples check [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const { buildExamplesCheck, renderExamplesCheckText } = await import('@shrkcrft/inspector');
    const report = buildExamplesCheck(cwd);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(report) + '\n');
      return report.ok ? 0 : 1;
    }
    process.stdout.write(renderExamplesCheckText(report));
    return report.ok ? 0 : 1;
  },
};
