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

export class Logger implements ILogger {
  level: LogLevel;
  private readonly scope: string;
  private readonly writer: (line: string) => void;
  private readonly json: boolean;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? LogLevel.Info;
    this.scope = options.scope ?? '';
    this.writer = options.writer ?? ((line) => process.stderr.write(line + '\n'));
    this.json = options.json ?? false;
  }

  error(message: string, meta?: Record<string, unknown>): void {
    if (this.level >= LogLevel.Error) this.emit('error', message, meta);
  }
  warn(message: string, meta?: Record<string, unknown>): void {
    if (this.level >= LogLevel.Warn) this.emit('warn', message, meta);
  }
  info(message: string, meta?: Record<string, unknown>): void {
    if (this.level >= LogLevel.Info) this.emit('info', message, meta);
  }
  debug(message: string, meta?: Record<string, unknown>): void {
    if (this.level >= LogLevel.Debug) this.emit('debug', message, meta);
  }
  trace(message: string, meta?: Record<string, unknown>): void {
    if (this.level >= LogLevel.Trace) this.emit('trace', message, meta);
  }

  child(scope: string): ILogger {
    const nested = this.scope ? `${this.scope}:${scope}` : scope;
    const child = new Logger({
      level: this.level,
      scope: nested,
      writer: this.writer,
      json: this.json,
    });
    return child;
  }

  private emit(level: string, message: string, meta?: Record<string, unknown>): void {
    if (this.json) {
      const payload = {
        ts: new Date().toISOString(),
        level,
        scope: this.scope || undefined,
        message,
        ...(meta ? { meta } : {}),
      };
      this.writer(JSON.stringify(payload));
      return;
    }
    const prefix = this.scope ? `[${level}] [${this.scope}]` : `[${level}]`;
    const metaStr = meta && Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    this.writer(`${prefix} ${message}${metaStr}`);
  }
}

let defaultLogger: ILogger | null = null;

export function getDefaultLogger(): ILogger {
  if (!defaultLogger) {
    defaultLogger = new Logger({ level: LogLevel.Info });
  }
  return defaultLogger;
}

export function setDefaultLogger(logger: ILogger): void {
  defaultLogger = logger;
}
