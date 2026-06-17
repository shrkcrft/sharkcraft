export {
  startMcpServer,
  createSharkcraftServer,
  resolveTargetRoot,
  type StartMcpServerOptions,
  type CreateSharkcraftServerOptions,
} from './server/create-mcp-server.ts';
export { startHttpServer, type HttpServerHandle } from './server/http-transport.ts';
export { startSharkcraftWatcher } from './server/sharkcraft-watcher.ts';
export { ALL_TOOLS } from './tools/index.ts';
// DX#4 — `ALL_TOOLS_FOR_AUDIT` was deleted. Consumers that need the
// `{ name, description }` projection should `ALL_TOOLS.map(...)`
// inline. The view is structurally identical to ALL_TOOLS by
// construction now.
export type {
  IToolDefinition,
  IToolResponse,
  IToolContext,
  IMcpGateDecision,
  McpGateResolver,
} from './server/tool-definition.ts';
export {
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
} from './server/mcp-server-config.ts';
export {
  buildResourceList,
  readResource,
  parseResourceUri,
  knowledgeUri,
  templateUri,
  docUri,
  OVERVIEW_URI,
  AGENT_INSTRUCTIONS_URI,
  URI_SCHEME,
} from './resources/index.ts';

export { getRelevantContextTool } from './tools/get-relevant-context.tool.ts';
export { getTaskPacketTool } from './tools/get-task-packet.tool.ts';
export { prepareAgentTaskTool } from './tools/r33-agent-task-prep.tool.ts';
export { COMMAND_CATALOG_EXPORT } from './tools/command-catalog.tool.ts';
