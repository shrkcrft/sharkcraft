export enum LogLevel {
  Silent = 0,
  Error = 1,
  Warn = 2,
  Info = 3,
  Debug = 4,
  Trace = 5,
}

export function parseLogLevel(value: string | undefined, fallback: LogLevel = LogLevel.Info): LogLevel {
  if (!value) return fallback;
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
