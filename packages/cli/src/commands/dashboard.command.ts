/**
 * `shrk dashboard` — start the local read-only dashboard.
 *
 * Defaults:
 *  - host: 127.0.0.1
 *  - port: 4567
 *  - open: true when interactive (TTY)
 *  - serves static UI from packages/dashboard/dist if available
 *  - GET/HEAD only; POST/PUT/PATCH/DELETE → 405
 *  - no write endpoints, ever
 *
 * Subcommand `shrk dashboard serve` is supported for backwards-compat.
 */
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { startDashboardApiServer } from '../dashboard/dashboard-api-server.ts';
import { asJson } from '../output/format-output.ts';

const DEFAULT_PORT = 4567;

export const dashboardCommand: ICommandHandler = {
  name: 'dashboard',
  description:
    'Start the local read-only SharkCraft dashboard (web UI + API). GET/HEAD only; 127.0.0.1 by default; no write endpoints.',
  usage:
    'shrk [--cwd <dir>] dashboard [serve] [--host <addr>] [--port <n>] [--open|--no-open] [--api-only] [--static-only] [--dev-assets <path>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    // `dashboard serve` is the same as `dashboard`.
    const positional = args.positional[0] === 'serve' ? args.positional.slice(1) : args.positional;
    const sliced: ParsedArgs = { ...args, positional };
    return runServe(sliced);
  },
};

function findStaticDir(args: ParsedArgs): string | null {
  const override = flagString(args, 'dev-assets');
  if (override) {
    const abs = nodePath.resolve(process.cwd(), override);
    return existsSync(nodePath.join(abs, 'index.html')) ? abs : null;
  }
  // Look near this source file: ../../../dashboard/dist
  const here = fileURLToPath(import.meta.url);
  const candidates = [
    nodePath.resolve(here, '../../../../dashboard/dist'),
    nodePath.resolve(here, '../../../dashboard/dist'),
    nodePath.resolve(process.cwd(), 'packages/dashboard/dist'),
  ];
  for (const c of candidates) {
    if (existsSync(nodePath.join(c, 'index.html'))) return c;
  }
  return null;
}

async function runServe(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const host = flagString(args, 'host') ?? '127.0.0.1';
  const port = Number(flagString(args, 'port') ?? String(DEFAULT_PORT));
  const apiOnly = flagBool(args, 'api-only');
  const staticOnly = flagBool(args, 'static-only');
  const wantJson = flagBool(args, 'json');
  const noOpen = flagBool(args, 'no-open');
  const open = !noOpen && (flagBool(args, 'open') || (!wantJson && process.stdout.isTTY === true));

  let staticDir: string | null = null;
  if (!apiOnly) {
    staticDir = findStaticDir(args);
    if (!staticDir && !staticOnly) {
      process.stderr.write(
        'Dashboard assets not built. Run `bun run dashboard:build` to build them, or pass --api-only to skip.\n',
      );
      // Continue API-only — not fatal.
    } else if (!staticDir && staticOnly) {
      process.stderr.write(
        'Dashboard assets not built. Run `bun run dashboard:build` first.\n',
      );
      return 1;
    }
  }

  const handle = await startDashboardApiServer({ cwd, host, port, staticDir: apiOnly ? null : staticDir });

  if (wantJson) {
    process.stdout.write(
      asJson({
        url: handle.url,
        host: handle.host,
        port: handle.port,
        projectRoot: cwd,
        staticDir,
        readOnly: true,
      }) + '\n',
    );
  } else {
    process.stdout.write(
      `SharkCraft dashboard at ${handle.url}\n` +
        `  project root: ${cwd}\n` +
        (staticDir ? `  static assets: ${staticDir}\n` : `  (api-only; no UI assets)\n`) +
        `  read-only: GET/HEAD only. The dashboard never writes — it shows copyable CLI commands.\n` +
        `(press Ctrl+C to stop)\n`,
    );
  }

  if (open && process.platform === 'darwin') {
    try {
      const { spawnSync } = (await import('node:child_process')) as typeof import('node:child_process');
      spawnSync('open', [handle.url]);
    } catch {
      /* ignore */
    }
  }
  return new Promise<number>((resolve) => {
    const shutdown = (): void => {
      handle.close().finally(() => resolve(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
