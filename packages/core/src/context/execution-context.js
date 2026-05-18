export function createExecutionContext(options) {
    return {
        cwd: options.cwd ?? process.cwd(),
        logger: options.logger,
        fs: options.fs,
        env: options.env ?? process.env,
        now: options.now ?? (() => new Date()),
    };
}
