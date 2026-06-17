import type { ISharkcraftInspection } from '@shrkcrft/inspector';
import type { ICcrStore } from '@shrkcrft/compress';

export interface IToolJsonSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface IToolContext {
  inspection: ISharkcraftInspection;
  cwd: string;
  /**
   * The full list of tools registered in the server. Tools that need
   * to self-reflect (e.g. `get_safety_audit`) use this instead of
   * importing `ALL_TOOLS` from the tool-registry to avoid import cycles.
   */
  allTools?: readonly IToolDefinition[];
  /**
   * Per-server in-memory Compress-Cache-Retrieve store. The
   * `compress_context` tool caches originals here and `retrieve_original`
   * reads them back. In-memory only — the MCP server never writes to disk,
   * honouring the read-only contract. Absent in unit tests that construct a
   * bare context.
   */
  ccrStore?: ICcrStore;
}

export interface IToolDefinition {
  name: string;
  description: string;
  inputSchema: IToolJsonSchema;
  handler: (input: Record<string, unknown>, context: IToolContext) => Promise<IToolResponse> | IToolResponse;
  /**
   * Optional CLI sibling command this tool mirrors. Used by the
   * tier-gating layer: if the sibling is experimental and not enabled
   * in the project's surface config, the MCP tool returns the same
   * structured not-enabled error the CLI does.
   *
   * Tools without a CLI sibling (bootstrap MCP-only tools like
   * `get_command_catalog` or `inspect_workspace`) leave this absent
   * and are always callable.
   */
  cliCommand?: string;
}

/**
 * Result of the MCP-side tier gate. `null` = callable, otherwise
 * structured info for the not-enabled response.
 */
export interface IMcpGateDecision {
  command: string;
  reason?: string;
}

export type McpGateResolver = (tool: IToolDefinition) => IMcpGateDecision | null;

export interface IToolError {
  /** Stable machine-readable error code (e.g. `cache-miss`, `not-found`). */
  code: string;
  /** Human-readable summary. */
  message: string;
  /** Optional structured details (recovery hints, suggested next calls). */
  details?: unknown;
}

export interface IToolResponse {
  /** Text representation. */
  text?: string;
  /** Structured JSON output (for clients that prefer it). */
  data?: unknown;
  /** True if the tool should be reported as an error. */
  isError?: boolean;
  /** Optional structured error block — set together with `isError: true`. */
  error?: IToolError;
}
