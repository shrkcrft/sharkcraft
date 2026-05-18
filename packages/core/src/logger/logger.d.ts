import { LogLevel } from './log-level.ts';
export interface ILogger {
    level: LogLevel;
    error(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
    debug(message: string, meta?: Record<string, unknown>): void;
    trace(message: string, meta?: Record<string, unknown>): void;
    child(scope: string): ILogger;
}
export interface LoggerOptions {
    level?: LogLevel;
    scope?: string;
    writer?: (line: string) => void;
    json?: boolean;
}
export declare class Logger implements ILogger {
    level: LogLevel;
    private readonly scope;
    private readonly writer;
    private readonly json;
    constructor(options?: LoggerOptions);
    error(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
    debug(message: string, meta?: Record<string, unknown>): void;
    trace(message: string, meta?: Record<string, unknown>): void;
    child(scope: string): ILogger;
    private emit;
}
export declare function getDefaultLogger(): ILogger;
export declare function setDefaultLogger(logger: ILogger): void;
//# sourceMappingURL=logger.d.ts.map