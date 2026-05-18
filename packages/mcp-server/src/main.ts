#!/usr/bin/env node
import { startMcpServer, type StartMcpServerOptions } from './server/create-mcp-server.ts';

function extractFlag(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === `--${name}`) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) return next;
      return undefined;
    }
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
  }
  return undefined;
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

const argv = process.argv.slice(2);
const verbose = hasFlag(argv, 'verbose') || process.env.SHARKCRAFT_MCP_VERBOSE === '1';
const watch = hasFlag(argv, 'watch');
const cliCwd = extractFlag(argv, 'cwd');
const useHttp = hasFlag(argv, 'http');
const host = extractFlag(argv, 'host');
const portStr = extractFlag(argv, 'port');
const port = portStr ? Number(portStr) : undefined;

const opts: StartMcpServerOptions = {
  cwd: cliCwd,
  verbose,
  watch,
};
if (useHttp) {
  opts.transport = 'http';
  if (host) opts.host = host;
  if (port !== undefined && Number.isFinite(port)) opts.port = port;
}

startMcpServer(opts).catch((e) => {
  process.stderr.write(`[mcp] fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
