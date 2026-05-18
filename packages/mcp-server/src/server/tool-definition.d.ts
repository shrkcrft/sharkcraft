import type { ISharkcraftInspection } from '@shrkcrft/inspector';
export interface IToolJsonSchema {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
}
export interface IToolContext {
    inspection: ISharkcraftInspection;
    cwd: string;
}
export interface IToolDefinition {
    name: string;
    description: string;
    inputSchema: IToolJsonSchema;
    handler: (input: Record<string, unknown>, context: IToolContext) => Promise<IToolResponse> | IToolResponse;
}
export interface IToolResponse {
    /** Text representation. */
    text?: string;
    /** Structured JSON output (for clients that prefer it). */
    data?: unknown;
    /** True if the tool should be reported as an error. */
    isError?: boolean;
}
//# sourceMappingURL=tool-definition.d.ts.map