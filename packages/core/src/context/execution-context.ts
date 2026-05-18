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

export function createExecutionContext(options: CreateExecutionContextOptions): IExecutionContext {
  return {
    cwd: options.cwd ?? process.cwd(),
    logger: options.logger,
    fs: options.fs,
    env: options.env ?? (process.env as Record<string, string | undefined>),
    now: options.now ?? (() => new Date()),
  };
}
