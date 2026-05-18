import { buildAreaMap, inspectSharkcraft, renderAreaMapMarkdown, renderAreaMapText } from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';

export const repoAreasCommand: ICommandHandler = {
  name: 'areas',
  description: 'Repository area map.',
  usage: 'shrk repo areas [--json|--format text|json|markdown]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const map = buildAreaMap(inspection);
    const fmt = flagString(args, 'format') ?? (flagBool(args, 'json') ? 'json' : 'text');
    if (fmt === 'json') {
      process.stdout.write(asJson(map) + '\n');
    } else if (fmt === 'markdown') {
      process.stdout.write(renderAreaMapMarkdown(map));
    } else {
      process.stdout.write(renderAreaMapText(map) + '\n');
    }
    return 0;
  },
};
