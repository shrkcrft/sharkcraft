export const ERROR_CODES = {
  UNKNOWN: 'SHRK_UNKNOWN',
  INVALID_INPUT: 'SHRK_INVALID_INPUT',
  NOT_FOUND: 'SHRK_NOT_FOUND',
  ALREADY_EXISTS: 'SHRK_ALREADY_EXISTS',
  CONFIG_NOT_FOUND: 'SHRK_CONFIG_NOT_FOUND',
  CONFIG_INVALID: 'SHRK_CONFIG_INVALID',
  PROJECT_ROOT_NOT_FOUND: 'SHRK_PROJECT_ROOT_NOT_FOUND',
  SHARKCRAFT_FOLDER_NOT_FOUND: 'SHRK_FOLDER_NOT_FOUND',
  PACKAGE_JSON_NOT_FOUND: 'SHRK_PACKAGE_JSON_NOT_FOUND',
  KNOWLEDGE_ENTRY_NOT_FOUND: 'SHRK_KNOWLEDGE_NOT_FOUND',
  KNOWLEDGE_DUPLICATE_ID: 'SHRK_KNOWLEDGE_DUPLICATE_ID',
  TEMPLATE_NOT_FOUND: 'SHRK_TEMPLATE_NOT_FOUND',
  TEMPLATE_VARIABLE_MISSING: 'SHRK_TEMPLATE_VAR_MISSING',
  TARGET_FILE_EXISTS: 'SHRK_TARGET_EXISTS',
  PATH_OUTSIDE_PROJECT: 'SHRK_PATH_OUTSIDE_PROJECT',
  MCP_INVALID_INPUT: 'SHRK_MCP_INVALID_INPUT',
  UNSUPPORTED_COMMAND: 'SHRK_UNSUPPORTED_COMMAND',
  FILE_READ_ERROR: 'SHRK_FILE_READ_ERROR',
  FILE_WRITE_ERROR: 'SHRK_FILE_WRITE_ERROR',
  LOADER_ERROR: 'SHRK_LOADER_ERROR',
  IO_ERROR: 'SHRK_IO_ERROR',
  TIMEOUT: 'SHRK_TIMEOUT',
} as const;

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

export class AppErrorImpl extends Error implements AppError {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown> | undefined;
  readonly suggestion?: string | undefined;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.details = options.details;
    this.suggestion = options.suggestion;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      suggestion: this.suggestion,
    };
  }
}

export function makeError(
  code: ErrorCode,
  message: string,
  options: AppErrorOptions = {},
): AppError {
  return new AppErrorImpl(code, message, options);
}
