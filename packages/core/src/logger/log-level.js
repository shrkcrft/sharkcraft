export var LogLevel;
(function (LogLevel) {
    LogLevel[LogLevel["Silent"] = 0] = "Silent";
    LogLevel[LogLevel["Error"] = 1] = "Error";
    LogLevel[LogLevel["Warn"] = 2] = "Warn";
    LogLevel[LogLevel["Info"] = 3] = "Info";
    LogLevel[LogLevel["Debug"] = 4] = "Debug";
    LogLevel[LogLevel["Trace"] = 5] = "Trace";
})(LogLevel || (LogLevel = {}));
export function parseLogLevel(value, fallback = LogLevel.Info) {
    if (!value)
        return fallback;
    switch (value.toLowerCase()) {
        case 'silent':
            return LogLevel.Silent;
        case 'error':
            return LogLevel.Error;
        case 'warn':
            return LogLevel.Warn;
        case 'info':
            return LogLevel.Info;
        case 'debug':
            return LogLevel.Debug;
        case 'trace':
            return LogLevel.Trace;
        default:
            return fallback;
    }
}
