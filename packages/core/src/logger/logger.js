import { LogLevel } from "./log-level.js";
export class Logger {
    level;
    scope;
    writer;
    json;
    constructor(options = {}) {
        this.level = options.level ?? LogLevel.Info;
        this.scope = options.scope ?? '';
        this.writer = options.writer ?? ((line) => process.stderr.write(line + '\n'));
        this.json = options.json ?? false;
    }
    error(message, meta) {
        if (this.level >= LogLevel.Error)
            this.emit('error', message, meta);
    }
    warn(message, meta) {
        if (this.level >= LogLevel.Warn)
            this.emit('warn', message, meta);
    }
    info(message, meta) {
        if (this.level >= LogLevel.Info)
            this.emit('info', message, meta);
    }
    debug(message, meta) {
        if (this.level >= LogLevel.Debug)
            this.emit('debug', message, meta);
    }
    trace(message, meta) {
        if (this.level >= LogLevel.Trace)
            this.emit('trace', message, meta);
    }
    child(scope) {
        const nested = this.scope ? `${this.scope}:${scope}` : scope;
        const child = new Logger({
            level: this.level,
            scope: nested,
            writer: this.writer,
            json: this.json,
        });
        return child;
    }
    emit(level, message, meta) {
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
let defaultLogger = null;
export function getDefaultLogger() {
    if (!defaultLogger) {
        defaultLogger = new Logger({ level: LogLevel.Info });
    }
    return defaultLogger;
}
export function setDefaultLogger(logger) {
    defaultLogger = logger;
}
