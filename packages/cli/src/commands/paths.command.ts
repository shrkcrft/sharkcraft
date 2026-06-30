import { inspectSharkcraft } from '@shrkcrft/inspector';
import { formatEntryCompact, formatEntryFull } from '@shrkcrft/knowledge';
import {
  flagBool,
  flagNumber,
  flagString,
  flagList,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';

export const pathsListCommand: ICommandHandler = {
  name: 'list',
  description: 'List path conventions.',
  usage: 'shrk paths list [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const paths = inspection.pathService.list();
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(paths) + '\n');
      return 0;
    }
    process.stdout.write(header(`Path conventions (${paths.length})`));
    for (const p of paths) {
      const target = (p.metadata?.path as string | undefined) ?? '(unknown)';
      process.stdout.write(`  ${p.id.padEnd(30)} → ${target}\n`);
      process.stdout.write(`     ${p.title} (priority=${p.priority})\n`);
    }
    return 0;
  },
};

export const pathsGetCommand: ICommandHandler = {
  name: 'get',
  description: 'Get one path convention.',
  usage: 'shrk paths get <id> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk paths get <id>\n');
      return 2;
    }
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const path = inspection.pathService.get(id);
    if (!path) {
      process.stderr.write(`No path convention with id "${id}".\n`);
      return 1;
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(path) + '\n');
      return 0;
    }
    process.stdout.write(formatEntryFull(path) + '\n');
    return 0;
  },
};

export const pathsSearchCommand: ICommandHandler = {
  name: 'search',
  description: 'Search path conventions.',
  usage: 'shrk paths search <query> [--scope x,y] [--limit 10]',
  async run(args: ParsedArgs): Promise<number> {
    const query = args.positional.join(' ').trim();
    const scope = flagList(args, 'scope');
    const limit = flagNumber(args, 'limit') ?? 10;
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const results = inspection.pathService.search({
      query: query.length ? query : undefined,
      scope: scope.length ? scope : undefined,
      limit,
    });
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(results) + '\n');
      return 0;
    }
    process.stdout.write(header(`Path conventions (${results.length})`));
    for (const r of results) process.stdout.write(formatEntryCompact(r) + '\n');
    return 0;
  },
};

export const pathsBestCommand: ICommandHandler = {
  name: 'best',
  description: 'Pick the best path for a task.',
  usage: 'shrk paths best --task "<task>"',
  async run(args: ParsedArgs): Promise<number> {
    const task = flagString(args, 'task');
    if (!task) {
      process.stderr.write('Missing --task\n');
      return 2;
    }
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const selection = inspection.pathService.findBestForTask(task);
    const wantJson = flagBool(args, 'json');
    if (!selection) {
      // Keep `--json` machine-parseable on a miss: emit `{match:null}` rather
      // than the human sentence so a consumer can `JSON.parse` the output.
      if (wantJson) {
        process.stdout.write(asJson({ match: null }) + '\n');
        return 0;
      }
      process.stdout.write('No matching path convention.\n');
      return 0;
    }
    if (wantJson) {
      process.stdout.write(asJson(selection) + '\n');
      return 0;
    }
    process.stdout.write(
      `Best: ${selection.convention.id} → ${selection.convention.metadata?.path as string}\n`,
    );
    process.stdout.write(`Reason: ${selection.reason} (score=${selection.score})\n`);
    return 0;
  },
};
