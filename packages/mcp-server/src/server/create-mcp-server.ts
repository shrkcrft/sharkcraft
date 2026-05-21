import * as nodePath from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { inspectSharkcraft, type ISharkcraftInspection } from '@shrkcrft/inspector';
import {
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  type IMcpServerConfig,
} from './mcp-server-config.ts';
import type {
  IToolDefinition,
  IToolResponse,
  McpGateResolver,
} from './tool-definition.ts';
import { ALL_TOOLS } from '../tools/index.ts';
import { PRIMARY_MCP_TOOLS, shouldAdvertiseFullToolset } from '../tools/primary-tools.ts';
import { validateToolInput } from './tool-input-validators.ts';
import { buildResourceList, readResource } from '../resources/index.ts';

export interface StartMcpServerOptions {
  /** Working directory for SharkCraft project detection. */
  cwd?: string;
  /** Alias for cwd. If both are given, projectRoot wins. */
  projectRoot?: string;
  verbose?: boolean;
  /** Watch sharkcraft/ for changes and emit resources/list_changed. */
  watch?: boolean;
  /**
   * Transport selection.
   * - 'stdio' (default) wires stdin/stdout (Claude Code style).
   * - 'http' starts a Streamable-HTTP server on host/port.
   */
  transport?: 'stdio' | 'http';
  /** HTTP host (when transport='http'). */
  host?: string;
  /** HTTP port (when transport='http'). */
  port?: number;
  /**
   * Tier gate resolver. When provided, every CallTool invocation
   * is consulted against the gate before the tool's handler runs. A
   * non-null return blocks the call with the structured not-enabled
   * error (mirrors the CLI behavior). Pass `null` for an open server.
   */
  gateResolver?: McpGateResolver;
}

export interface CreateSharkcraftServerOptions extends IMcpServerConfig {
  /** Alias for cwd. If both are given, projectRoot wins. */
  projectRoot?: string;
  /** See {@link StartMcpServerOptions.gateResolver}. */
  gateResolver?: McpGateResolver;
}

interface ServerState {
  config: IMcpServerConfig;
  inspection: ISharkcraftInspection | null;
  toolsByName: Map<string, IToolDefinition>;
  /** Optional tier-gate resolver. */
  gateResolver?: McpGateResolver;
}

/**
 * Resolve which directory the MCP server should treat as the target project.
 * Priority: explicit option > SHARKCRAFT_PROJECT_ROOT env > process.cwd().
 */
export function resolveTargetRoot(
  optionCwd: string | undefined,
  optionProjectRoot: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  const raw =
    optionProjectRoot ?? optionCwd ?? env.SHARKCRAFT_PROJECT_ROOT ?? process.cwd();
  return nodePath.resolve(raw);
}

async function loadInspection(state: ServerState): Promise<ISharkcraftInspection> {
  if (state.inspection) return state.inspection;
  state.inspection = await inspectSharkcraft({ cwd: state.config.cwd });
  return state.inspection;
}

function toolResponseToCallResult(response: IToolResponse): {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
} {
  const content: Array<{ type: 'text'; text: string }> = [];
  if (response.text) content.push({ type: 'text', text: response.text });
  if (response.data !== undefined) {
    content.push({ type: 'text', text: JSON.stringify(response.data, null, 2) });
  }
  if (content.length === 0) content.push({ type: 'text', text: '(empty)' });
  return { content, isError: response.isError ?? false };
}

export function createSharkcraftServer(config: CreateSharkcraftServerOptions): {
  server: Server;
  state: ServerState;
} {
  const resolvedCwd = resolveTargetRoot(config.cwd, config.projectRoot);
  const effectiveConfig: IMcpServerConfig = {
    name: config.name,
    version: config.version,
    cwd: resolvedCwd,
    verbose: config.verbose,
  };

  const state: ServerState = {
    config: effectiveConfig,
    inspection: null,
    toolsByName: new Map(ALL_TOOLS.map((t) => [t.name, t])),
    ...(config.gateResolver ? { gateResolver: config.gateResolver } : {}),
  };

  const server = new Server(
    { name: effectiveConfig.name, version: effectiveConfig.version },
    {
      capabilities: {
        tools: {},
        resources: { listChanged: true },
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Default `tools/list` advertises only the ~30 primary tools to
    // keep the agent's tool-selection surface focused. The other ~200
    // tools stay CALLABLE via `tools/call` for agents that already
    // know the name (e.g. via `shrk export claude-skill` referencing
    // them). Set SHRK_MCP_FULL_TOOLS=1 to advertise everything.
    const advertiseFull = shouldAdvertiseFullToolset();
    const advertised = advertiseFull
      ? ALL_TOOLS
      : ALL_TOOLS.filter((t) => PRIMARY_MCP_TOOLS.has(t.name));
    return {
      tools: advertised.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as unknown as Record<string, unknown>,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const tool = state.toolsByName.get(name);
    if (!tool) {
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    // Tier gate. When the host wires a gateResolver, an
    // experimental tool refuses with the same structured error the
    // CLI emits. Bootstrap tools (no `cliCommand` field) always
    // pass through.
    if (state.gateResolver) {
      const decision = state.gateResolver(tool);
      if (decision) {
        const body = {
          schema: 'sharkcraft.surface.not-enabled.v1',
          command: decision.command,
          tier: 'experimental',
          reason:
            decision.reason ??
            `MCP tool ${name} is gated: its CLI sibling \`${decision.command}\` is experimental and not enabled.`,
          enableCommand: `shrk surface enable ${decision.command}`,
          explainCommand: `shrk surface explain ${decision.command}`,
        };
        return {
          content: [
            { type: 'text' as const, text: body.reason },
            { type: 'text' as const, text: JSON.stringify(body, null, 2) },
          ],
          isError: true,
        };
      }
    }
    const validation = validateToolInput(name, args);
    if (!validation.ok) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Invalid input for "${name}": ${validation.failure.message}`,
          },
          {
            type: 'text' as const,
            text: JSON.stringify({ issues: validation.failure.issues }, null, 2),
          },
        ],
        isError: true,
      };
    }
    try {
      const inspection = await loadInspection(state);
      const response = await tool.handler(
        validation.data as Record<string, unknown>,
        { inspection, cwd: state.config.cwd },
      );
      return toolResponseToCallResult(response);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        content: [{ type: 'text' as const, text: `Tool "${name}" failed: ${message}` }],
        isError: true,
      };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const inspection = await loadInspection(state);
    return { resources: buildResourceList(inspection) };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const inspection = await loadInspection(state);
    const result = readResource(inspection, request.params.uri);
    if (!result.ok) {
      throw new Error(result.error);
    }
    return { contents: result.contents };
  });

  return { server, state };
}

export async function startMcpServer(options: StartMcpServerOptions = {}): Promise<void> {
  const cwd = resolveTargetRoot(options.cwd, options.projectRoot);
  const verbose = options.verbose ?? false;

  const { server, state } = createSharkcraftServer({
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
    cwd,
    verbose,
    ...(options.gateResolver ? { gateResolver: options.gateResolver } : {}),
  });

  // Pre-warm inspection so the first tools/call is fast.
  loadInspection(state).catch(() => undefined);

  if (verbose) {
    process.stderr.write(`[mcp] SharkCraft MCP server starting (cwd=${cwd})\n`);
    process.stderr.write(
      `[mcp] Tools (${ALL_TOOLS.length}): ${ALL_TOOLS.map((t) => t.name).join(', ')}\n`,
    );
  }

  // Optional watch — invalidates the inspection cache and notifies clients.
  let watcher: { stop: () => void } | null = null;
  if (options.watch) {
    const { startSharkcraftWatcher } = await import('./sharkcraft-watcher.ts');
    watcher = startSharkcraftWatcher({
      cwd,
      onChange: async () => {
        state.inspection = null;
        try {
          await server.sendResourceListChanged();
          if (verbose) process.stderr.write('[mcp] resources/list_changed sent\n');
        } catch (e) {
          if (verbose) {
            process.stderr.write(`[mcp] notify failed: ${(e as Error).message}\n`);
          }
        }
      },
      log: (line) => verbose && process.stderr.write(`[mcp:watch] ${line}\n`),
    });
  }

  const transportKind = options.transport ?? 'stdio';
  if (transportKind === 'http') {
    const { startHttpServer } = await import('./http-transport.ts');
    const handle = await startHttpServer({
      server,
      host: options.host,
      port: options.port,
      log: (line) => verbose && process.stderr.write(line + '\n'),
    });
    // Keep process alive until SIGINT/SIGTERM, then close.
    const stop = async (): Promise<void> => {
      watcher?.stop();
      await handle.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void stop());
    process.on('SIGTERM', () => void stop());
    if (verbose) process.stderr.write(`[mcp] http endpoint: ${handle.url}\n`);
    return;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (verbose) process.stderr.write('[mcp] connected via stdio\n');
}
