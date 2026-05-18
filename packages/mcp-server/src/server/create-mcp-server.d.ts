import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { type ISharkcraftInspection } from '@shrkcrft/inspector';
import { type IMcpServerConfig } from './mcp-server-config.ts';
import type { IToolDefinition } from './tool-definition.ts';
export interface StartMcpServerOptions {
    /** Working directory for SharkCraft project detection. */
    cwd?: string;
    /** Alias for cwd. If both are given, projectRoot wins. */
    projectRoot?: string;
    verbose?: boolean;
}
export interface CreateSharkcraftServerOptions extends IMcpServerConfig {
    /** Alias for cwd. If both are given, projectRoot wins. */
    projectRoot?: string;
}
interface ServerState {
    config: IMcpServerConfig;
    inspection: ISharkcraftInspection | null;
    toolsByName: Map<string, IToolDefinition>;
}
/**
 * Resolve which directory the MCP server should treat as the target project.
 * Priority: explicit option > SHARKCRAFT_PROJECT_ROOT env > process.cwd().
 */
export declare function resolveTargetRoot(optionCwd: string | undefined, optionProjectRoot: string | undefined, env?: Record<string, string | undefined>): string;
export declare function createSharkcraftServer(config: CreateSharkcraftServerOptions): {
    server: Server;
    state: ServerState;
};
export declare function startMcpServer(options?: StartMcpServerOptions): Promise<void>;
export {};
//# sourceMappingURL=create-mcp-server.d.ts.map