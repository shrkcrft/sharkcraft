/**
 * `shrk registry` commands.
 *
 *   shrk registry lifecycle [--json]
 */
import {
  buildRegistryLifecycleReport,
  renderRegistryLifecycleReportText,
} from '@shrkcrft/inspector';
import {
  flagBool,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';

export const registryLifecycleCommand: ICommandHandler = {
  name: 'lifecycle',
  description: 'Scan the workspace for register*/remove* symmetry. Read-only.',
  usage: 'shrk registry lifecycle [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const report = buildRegistryLifecycleReport({ projectRoot: cwd });
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(report) + '\n');
      return report.missingRemovers.length === 0 ? 0 : 1;
    }
    process.stdout.write(renderRegistryLifecycleReportText(report));
    return report.missingRemovers.length === 0 ? 0 : 1;
  },
};

export const registryCommand: ICommandHandler = {
  name: 'registry',
  description: 'Registry inspections (lifecycle symmetry, etc.). Read-only.',
  usage: 'shrk registry lifecycle',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    if (sub === 'lifecycle') {
      args.positional = args.positional.slice(1);
      return registryLifecycleCommand.run(args);
    }
    process.stderr.write('Usage: shrk registry lifecycle\n');
    return 2;
  },
};
