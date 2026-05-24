#!/usr/bin/env bun
// dashboard-dev: start the dashboard backend (:4567) and the Vite UI (:4569)
// together with shared lifecycle. Ctrl-C cleans up both; if either child
// exits, the other is killed and the script exits with that code.
//
// Use this when developing the dashboard UI — Vite proxies /api/* to 4567,
// so the backend MUST be running or every API call 500s.
//
// Usage:
//   bun run scripts/dashboard-dev.ts
//   bun run scripts/dashboard-dev.ts --backend-port 5000 --ui-port 6000
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { join } from 'node:path';

const ROOT = process.cwd();

interface IArgs {
  backendPort: number;
  uiPort: number;
}

function parseArgs(argv: readonly string[]): IArgs {
  const out: IArgs = { backendPort: 4567, uiPort: 4569 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const n = argv[i + 1];
    if (a === '--backend-port' && n) {
      out.backendPort = Number(n);
      i += 1;
    } else if (a === '--ui-port' && n) {
      out.uiPort = Number(n);
      i += 1;
    }
  }
  return out;
}

function waitForPort(port: number, host = '127.0.0.1', timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = (): void => {
      const sock = createConnection({ port, host });
      sock.once('connect', () => {
        sock.end();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`timed out waiting for ${host}:${port}`));
          return;
        }
        setTimeout(tryOnce, 250);
      });
    };
    tryOnce();
  });
}

function prefixed(name: string, color: string, child: ChildProcess): void {
  const tag = `\x1b[${color}m[${name}]\x1b[0m`;
  child.stdout?.on('data', (buf: Buffer) => {
    for (const line of buf.toString('utf8').replace(/\n$/, '').split('\n')) {
      process.stdout.write(`${tag} ${line}\n`);
    }
  });
  child.stderr?.on('data', (buf: Buffer) => {
    for (const line of buf.toString('utf8').replace(/\n$/, '').split('\n')) {
      process.stderr.write(`${tag} ${line}\n`);
    }
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  process.stdout.write(`[dashboard-dev] backend on :${args.backendPort}, vite on :${args.uiPort}\n`);

  const backend = spawn(
    'bun',
    ['run', join(ROOT, 'packages/cli/src/main.ts'), 'dashboard', '--port', String(args.backendPort), '--no-open'],
    { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  prefixed('api', '36', backend);

  let shuttingDown = false;
  const children: ChildProcess[] = [backend];

  const shutdown = (signal: NodeJS.Signals | 'exit', code = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const c of children) {
      if (c.exitCode === null && !c.killed) {
        try {
          c.kill(signal === 'exit' ? 'SIGTERM' : signal);
        } catch {
          /* ignore */
        }
      }
    }
    setTimeout(() => process.exit(code), 250).unref();
  };

  backend.on('exit', (code) => {
    process.stdout.write(`[dashboard-dev] api exited (code=${code ?? 'null'})\n`);
    shutdown('exit', code ?? 1);
  });
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await waitForPort(args.backendPort);
  } catch (e) {
    process.stderr.write(`[dashboard-dev] backend never came up: ${(e as Error).message}\n`);
    shutdown('exit', 1);
    return;
  }
  process.stdout.write(`[dashboard-dev] backend ready — starting Vite\n`);

  const vite = spawn('bun', ['x', 'vite', '--port', String(args.uiPort)], {
    cwd: join(ROOT, 'packages/dashboard'),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(vite);
  prefixed('ui ', '35', vite);

  vite.on('exit', (code) => {
    process.stdout.write(`[dashboard-dev] vite exited (code=${code ?? 'null'})\n`);
    shutdown('exit', code ?? 1);
  });
}

main().catch((e) => {
  process.stderr.write(`[dashboard-dev] fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
