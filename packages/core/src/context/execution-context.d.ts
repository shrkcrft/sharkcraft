import type { ILogger } from '../logger/logger.ts';
import type { IFileSystem } from '../fs/file-system.ts';
export interface IExecutionContext {
    readonly cwd: string;
    readonly logger: ILogger;
    readonly fs: IFileSystem;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly now: () => Date;
}
export interface CreateExecutionContextOptions {
    cwd?: string;
    logger: ILogger;
    fs: IFileSystem;
    env?: Record<string, string | undefined>;
    now?: () => Date;
}
export declare function createExecutionContext(options: CreateExecutionContextOptions): IExecutionContext;
//# sourceMappingURL=execution-context.d.ts.map