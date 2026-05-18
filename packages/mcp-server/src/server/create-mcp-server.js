import * as nodePath from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { MCP_SERVER_NAME, MCP_SERVER_VERSION, } from "./mcp-server-config.js";
import { ALL_TOOLS } from "../tools/index.js";
import { validateToolInput } from "./tool-input-validators.js";
import { buildResourceList, readResource } from "../resources/index.js";
/**
 * Resolve which directory the MCP server should treat as the target project.
 * Priority: explicit option > SHARKCRAFT_PROJECT_ROOT env > process.cwd().
 */
export function resolveTargetRoot(optionCwd, optionProjectRoot, env = process.env) {
    const raw = optionProjectRoot ?? optionCwd ?? env.SHARKCRAFT_PROJECT_ROOT ?? process.cwd();
    return nodePath.resolve(raw);
}
async function loadInspection(state) {
    if (state.inspection)
        return state.inspection;
    state.inspection = await inspectSharkcraft({ cwd: state.config.cwd });
    return state.inspection;
}
function toolResponseToCallResult(response) {
    const content = [];
    if (response.text)
        content.push({ type: 'text', text: response.text });
    if (response.data !== undefined) {
        content.push({ type: 'text', text: JSON.stringify(response.data, null, 2) });
    }
    if (content.length === 0)
        content.push({ type: 'text', text: '(empty)' });
    return { content, isError: response.isError ?? false };
}
export function createSharkcraftServer(config) {
    const resolvedCwd = resolveTargetRoot(config.cwd, config.projectRoot);
    const effectiveConfig = {
        name: config.name,
        version: config.version,
        cwd: resolvedCwd,
        verbose: config.verbose,
    };
    const state = {
        config: effectiveConfig,
        inspection: null,
        toolsByName: new Map(ALL_TOOLS.map((t) => [t.name, t])),
    };
    const server = new Server({ name: effectiveConfig.name, version: effectiveConfig.version }, { capabilities: { tools: {}, resources: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: ALL_TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
        })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const name = request.params.name;
        const args = (request.params.arguments ?? {});
        const tool = state.toolsByName.get(name);
        if (!tool) {
            return {
                content: [{ type: 'text', text: `Unknown tool: ${name}` }],
                isError: true,
            };
        }
        const validation = validateToolInput(name, args);
        if (!validation.ok) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Invalid input for "${name}": ${validation.failure.message}`,
                    },
                    {
                        type: 'text',
                        text: JSON.stringify({ issues: validation.failure.issues }, null, 2),
                    },
                ],
                isError: true,
            };
        }
        try {
            const inspection = await loadInspection(state);
            const response = await tool.handler(validation.data, { inspection, cwd: state.config.cwd });
            return toolResponseToCallResult(response);
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return {
                content: [{ type: 'text', text: `Tool "${name}" failed: ${message}` }],
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
export async function startMcpServer(options = {}) {
    const cwd = resolveTargetRoot(options.cwd, options.projectRoot);
    const verbose = options.verbose ?? false;
    const { server, state } = createSharkcraftServer({
        name: MCP_SERVER_NAME,
        version: MCP_SERVER_VERSION,
        cwd,
        verbose,
    });
    // Pre-warm inspection so the first tools/call is fast.
    loadInspection(state).catch(() => undefined);
    if (verbose) {
        process.stderr.write(`[mcp] SharkCraft MCP server starting (cwd=${cwd})\n`);
        process.stderr.write(`[mcp] Tools (${ALL_TOOLS.length}): ${ALL_TOOLS.map((t) => t.name).join(', ')}\n`);
    }
    const transport = new StdioServerTransport();
    await server.connect(transport);
    if (verbose)
        process.stderr.write('[mcp] connected via stdio\n');
}
