import {
  exploreArea,
  inspectSharkcraft,
  renderAreaExploreMarkdown,
  renderAreaExploreText,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';
import { COMMAND_CATALOG } from './command-catalog.ts';

const ALL_MCP_TOOL_NAMES: string[] = [];

async function getMcpToolNames(): Promise<readonly string[]> {
  if (ALL_MCP_TOOL_NAMES.length > 0) return ALL_MCP_TOOL_NAMES;
  try {
    const mod = (await import('@shrkcrft/mcp-server')) as unknown as {
      ALL_TOOLS?: ReadonlyArray<{ name: string }>;
    };
    if (mod?.ALL_TOOLS) {
      for (const t of mod.ALL_TOOLS) ALL_MCP_TOOL_NAMES.push(t.name);
    }
  } catch {
    // mcp-server not loadable from this entry — leave the list empty.
  }
  return ALL_MCP_TOOL_NAMES;
}

export const exploreCommand: ICommandHandler = {
  name: 'explore',
  description:
    'Explore a directory: area kind, key modules, related commands/MCP tools, tests, conventions, risks. Read-only.',
  usage: 'shrk explore <path> [--format text|markdown|json] [--top N]',
  async run(args: ParsedArgs): Promise<number> {
    const rawPath = args.positional[0];
    if (!rawPath) {
      process.stderr.write('Usage: shrk explore <path> [--format text|markdown|json]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const mcpToolNames = await getMcpToolNames();
    const pathConventions = inspection.pathService.list().map((p) => ({
      id: p.id,
      pattern:
        (p.metadata as Readonly<Record<string, unknown>> | undefined)?.path as string | undefined,
    }));
    const top = (() => {
      const n = flagString(args, 'top');
      if (!n) return undefined;
      const v = Number(n);
      return Number.isFinite(v) && v > 0 ? v : undefined;
    })();
    const report = exploreArea({
      inspection,
      path: rawPath,
      commandCatalog: COMMAND_CATALOG,
      mcpToolNames,
      pathConventions,
      ...(top ? { topFiles: top } : {}),
    });
    const format = flagString(args, 'format') ?? (flagBool(args, 'json') ? 'json' : 'text');
    if (format === 'json') {
      process.stdout.write(asJson(report) + '\n');
      return report.exists ? 0 : 1;
    }
    if (format === 'markdown') {
      process.stdout.write(renderAreaExploreMarkdown(report));
      return report.exists ? 0 : 1;
    }
    process.stdout.write(renderAreaExploreText(report));
    return report.exists ? 0 : 1;
  },
};
