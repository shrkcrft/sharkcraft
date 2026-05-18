export declare const ERROR_CODES: {
    readonly UNKNOWN: "SHRK_UNKNOWN";
    readonly INVALID_INPUT: "SHRK_INVALID_INPUT";
    readonly NOT_FOUND: "SHRK_NOT_FOUND";
    readonly ALREADY_EXISTS: "SHRK_ALREADY_EXISTS";
    readonly CONFIG_NOT_FOUND: "SHRK_CONFIG_NOT_FOUND";
    readonly CONFIG_INVALID: "SHRK_CONFIG_INVALID";
    readonly PROJECT_ROOT_NOT_FOUND: "SHRK_PROJECT_ROOT_NOT_FOUND";
    readonly SHARKCRAFT_FOLDER_NOT_FOUND: "SHRK_FOLDER_NOT_FOUND";
    readonly PACKAGE_JSON_NOT_FOUND: "SHRK_PACKAGE_JSON_NOT_FOUND";
    readonly KNOWLEDGE_ENTRY_NOT_FOUND: "SHRK_KNOWLEDGE_NOT_FOUND";
    readonly KNOWLEDGE_DUPLICATE_ID: "SHRK_KNOWLEDGE_DUPLICATE_ID";
    readonly TEMPLATE_NOT_FOUND: "SHRK_TEMPLATE_NOT_FOUND";
    readonly TEMPLATE_VARIABLE_MISSING: "SHRK_TEMPLATE_VAR_MISSING";
    readonly TARGET_FILE_EXISTS: "SHRK_TARGET_EXISTS";
    readonly PATH_OUTSIDE_PROJECT: "SHRK_PATH_OUTSIDE_PROJECT";
    readonly MCP_INVALID_INPUT: "SHRK_MCP_INVALID_INPUT";
    readonly UNSUPPORTED_COMMAND: "SHRK_UNSUPPORTED_COMMAND";
    readonly FILE_READ_ERROR: "SHRK_FILE_READ_ERROR";
    readonly FILE_WRITE_ERROR: "SHRK_FILE_WRITE_ERROR";
    readonly LOADER_ERROR: "SHRK_LOADER_ERROR";
    readonly IO_ERROR: "SHRK_IO_ERROR";
};
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
export interface AppError extends Error {
    readonly code: ErrorCode;
    readonly details?: Record<string, unknown> | undefined;
    readonly suggestion?: string | undefined;
}
export interface AppErrorOptions {
    details?: Record<string, unknown>;
    suggestion?: string;
    cause?: unknown;
}
export declare class AppErrorImpl extends Error implements AppError {
    readonly code: ErrorCode;
    readonly details?: Record<string, unknown> | undefined;
    readonly suggestion?: string | undefined;
    constructor(code: ErrorCode, message: string, options?: AppErrorOptions);
    toJSON(): Record<string, unknown>;
}
export declare function makeError(code: ErrorCode, message: string, options?: AppErrorOptions): AppError;
//# sourceMappingURL=errors.d.ts.map