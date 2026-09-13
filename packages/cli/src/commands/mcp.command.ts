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
import { PositionalMode } from '../dispatch/positional-mode.ts';
import { printError } from '../output/print-error.ts';
import { loadSurfaceContext } from '../surface/load-surface-context.ts';
import { surfaceRefusalFor } from '../surface/not-enabled-error.ts';
import { SurfaceRefusalReason } from '../surface/surface-refusal-reason.ts';
import {
  buildSurfaceSummary,
  findCommandInSummary,
  type ISurfaceCommandView,
} from '../surface/surface-summary.ts';

export const mcpCommand: ICommandHandler = {
  name: 'mcp',
  positionals: PositionalMode.None,
  subverbs: [
    {
      name: 'serve',
      description: 'Start the read-only MCP server (stdio, or --http).',
      usage: 'shrk [--cwd <dir>] mcp serve [--verbose] [--watch] [--http] [--port <n>] [--host <h>]',
    },
  ],
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
 * The same summary the CLI surface gate reads, so a tool whose sibling is a
 * tool-maintenance command (`get_docs_check` → `docs check`) is refused
 * outside SharkCraft's own repository, and one whose sibling a
 * `surface.disabled` selector denies is refused too — with the CLI's reason.
 *
 * Failure-soft: any error building the summary returns a no-op
 * resolver — the server stays open rather than failing closed on
 * unrelated issues.
 */
export async function buildMcpGateResolver(
  cwd: string,
): Promise<((tool: IToolDefinition) => IMcpGateDecision | null) | undefined> {
  try {
    const { context } = await loadSurfaceContext({ cwd });
    const summary = buildSurfaceSummary(context);
    return (tool: IToolDefinition): IMcpGateDecision | null => {
      if (!tool.cliCommand) return null;
      const view = findCommandInSummary(summary, tool.cliCommand);
      if (!view || view.callable) return null;
      return { command: tool.cliCommand, reason: mcpGateReason(tool.cliCommand, view) };
    };
  } catch {
    return undefined;
  }
}

/** The refusal reason an MCP tool reports — the CLI gate's cause and remedy. */
function mcpGateReason(cliCommand: string, view: ISurfaceCommandView): string {
  const refusal = surfaceRefusalFor(view);
  switch (refusal.reasonCode) {
    case SurfaceRefusalReason.ToolMaintenance:
      return `${refusal.reason} To run it anyway: ${refusal.enableCommand}`;
    case SurfaceRefusalReason.Disabled:
      return `${refusal.reason} To allow it again: ${refusal.enableCommand}`;
    case SurfaceRefusalReason.Experimental:
      return view.detail
        ? `Sibling CLI command \`${cliCommand}\` is experimental: ${view.detail}.`
        : `Sibling CLI command \`${cliCommand}\` is experimental and not enabled.`;
  }
}
