import {
  startMcpServer,
  type IMcpGateDecision,
  type IToolDefinition,
  type StartMcpServerOptions,
} from '@shrkcrft/mcp-server';
import {
  flagBool,
  flagNumber,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { printError } from '../output/print-error.ts';
import { loadSurfaceContext } from '../surface/load-surface-context.ts';
import { buildSurfaceSummary, findCommandInSummary } from '../surface/surface-summary.ts';

export const mcpCommand: ICommandHandler = {
  name: 'mcp',
  description: 'MCP server operations (subcommand required).',
  usage:
    'shrk [--cwd <dir>] mcp serve [--verbose] [--watch] [--http] [--port <n>] [--host <h>]',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    if (sub === 'serve') {
      try {
        const cwd = resolveCwd(args);
        const opts: StartMcpServerOptions = {
          cwd,
          verbose: flagBool(args, 'verbose'),
          watch: flagBool(args, 'watch'),
          gateResolver: await buildMcpGateResolver(cwd),
        };
        if (flagBool(args, 'http')) {
          opts.transport = 'http';
          const host = flagString(args, 'host');
          if (host) opts.host = host;
          const port = flagNumber(args, 'port');
          if (port !== undefined) opts.port = port;
        }
        await startMcpServer(opts);
        return 0;
      } catch (e) {
        printError(e instanceof Error ? e : new Error(String(e)));
        return 1;
      }
    }
    process.stderr.write('Usage: shrk mcp serve [--http] [--port N] [--watch]\n');
    return 2;
  },
};

/**
 * Build the MCP tier-gate resolver from the surface summary.
 * Returns a function that, given a tool, decides whether to refuse the
 * call (when the tool's sibling CLI command is experimental and not
 * enabled). Tools without `cliCommand` are always callable
 * (bootstrap MCP-only tools).
 *
 * Failure-soft: any error building the summary returns a no-op
 * resolver — the server stays open rather than failing closed on
 * unrelated issues.
 */
async function buildMcpGateResolver(
  cwd: string,
): Promise<((tool: IToolDefinition) => IMcpGateDecision | null) | undefined> {
  try {
    const { context } = await loadSurfaceContext({ cwd });
    const summary = buildSurfaceSummary(context);
    return (tool: IToolDefinition): IMcpGateDecision | null => {
      if (!tool.cliCommand) return null;
      const view = findCommandInSummary(summary, tool.cliCommand);
      if (!view || view.callable) return null;
      return {
        command: tool.cliCommand,
        reason: view.detail
          ? `Sibling CLI command \`${tool.cliCommand}\` is experimental: ${view.detail}.`
          : `Sibling CLI command \`${tool.cliCommand}\` is experimental and not enabled.`,
      };
    };
  } catch {
    return undefined;
  }
}
