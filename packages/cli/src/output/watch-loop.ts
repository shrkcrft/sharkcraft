/**
 * Lightweight watch loop helper.
 *
 * Reused by doctor / knowledge stale-check / templates drift / test agent /
 * `shrk watch integrity`. Debounces fs change events, runs the supplied
 * snapshot once at startup, and short-circuits when --once is passed.
 *
 * Linux: falls back to a non-recursive watcher when `recursive: true` throws.
 */
import { existsSync, watch as fsWatch } from 'node:fs';
import * as nodePath from 'node:path';

export interface IWatchLoopOptions {
  cwd: string;
  /** Run a single iteration and exit. */
  once?: boolean;
  /** Debounce delay (ms). Default 300. */
  debounce?: number;
  /** Extra paths to watch (relative to cwd). Defaults to `sharkcraft/`. */
  paths?: readonly string[];
}

export interface IWatchLoopHandlers {
  /** Produce one snapshot. */
  snapshot(): Promise<void>;
  /** Optional cleanup. */
  shutdown?: () => Promise<void> | void;
}

export async function runWatchLoop(
  options: IWatchLoopOptions,
  handlers: IWatchLoopHandlers,
): Promise<number> {
  const cwd = options.cwd;
  const debounce = options.debounce ?? 300;
  const watchPaths = (options.paths && options.paths.length > 0
    ? options.paths
    : ['sharkcraft']
  ).map((p) => (nodePath.isAbsolute(p) ? p : nodePath.join(cwd, p)));

  // Initial snapshot.
  await handlers.snapshot();

  if (options.once) {
    if (handlers.shutdown) await handlers.shutdown();
    return 0;
  }

  const existing = watchPaths.filter((p) => existsSync(p));
  if (existing.length === 0) {
    process.stderr.write(
      `[watch] no watchable paths under ${cwd}. Add sharkcraft/ or pass --paths.\n`,
    );
    if (handlers.shutdown) await handlers.shutdown();
    return 1;
  }

  process.stdout.write('\n[watch] running — Ctrl-C to stop.\n');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        await handlers.snapshot();
      } catch (e) {
        process.stderr.write(`[watch] error: ${(e as Error).message}\n`);
      }
    }, debounce);
  };

  const watchers: { close(): void }[] = [];
  for (const p of existing) {
    try {
      watchers.push(fsWatch(p, { recursive: true }, () => schedule()));
    } catch {
      // Linux fallback — non-recursive top-level watch.
      watchers.push(fsWatch(p, () => schedule()));
    }
  }

  return new Promise<number>((resolve) => {
    process.on('SIGINT', () => {
      for (const w of watchers) w.close();
      if (handlers.shutdown) Promise.resolve(handlers.shutdown()).finally(() => {
        process.stdout.write('\n[watch] stopped.\n');
        resolve(0);
      });
      else {
        process.stdout.write('\n[watch] stopped.\n');
        resolve(0);
      }
    });
  });
}

/**
 * Build a "plan" describing what a watch loop would do — used by MCP / tests
 * to verify watch wiring without keeping a process open.
 */
export interface IWatchPlan {
  schema: 'sharkcraft.watch-plan/v1';
  cwd: string;
  debounce: number;
  paths: readonly string[];
  steps: readonly string[];
}

export function buildWatchPlan(
  options: IWatchLoopOptions,
  steps: readonly string[],
): IWatchPlan {
  const watchPaths = (options.paths && options.paths.length > 0
    ? options.paths
    : ['sharkcraft']
  );
  return {
    schema: 'sharkcraft.watch-plan/v1',
    cwd: options.cwd,
    debounce: options.debounce ?? 300,
    paths: watchPaths,
    steps,
  };
}

import type { ParsedArgs } from '../command-registry.ts';
import { flagBool, flagNumber, flagString, resolveCwd } from '../command-registry.ts';

export interface IWatchModeOptions {
  /**
   * Paths to watch when the user does not pass `--paths`. Defaults to
   * `['sharkcraft']` if omitted. Use this for commands that scan code
   * outside `sharkcraft/` (e.g. `check boundaries` scans the whole repo).
   */
  defaultPaths?: readonly string[];
}

/**
 * Run a command's `run` function inside a watch loop when --watch is set.
 *
 * @returns null if --watch is not set (caller proceeds as before), otherwise
 * the exit code of the watch loop.
 */
export async function maybeRunInWatchMode(
  args: ParsedArgs,
  runner: (innerArgs: ParsedArgs) => Promise<number>,
  options: IWatchModeOptions = {},
): Promise<number | null> {
  if (!flagBool(args, 'watch')) return null;
  const cwd = resolveCwd(args);
  const debounce = flagNumber(args, 'debounce') ?? 300;
  const once = flagBool(args, 'once');
  const pathsFlag = flagString(args, 'paths');
  const userPaths = pathsFlag
    ? pathsFlag.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : [];
  const paths =
    userPaths.length > 0
      ? userPaths
      : options.defaultPaths && options.defaultPaths.length > 0
        ? options.defaultPaths
        : ['sharkcraft'];
  // Strip --watch so the inner snapshot doesn't recurse.
  const innerFlags = new Map(args.flags);
  innerFlags.delete('watch');
  innerFlags.delete('once');
  innerFlags.delete('debounce');
  innerFlags.delete('paths');
  const innerArgs: ParsedArgs = {
    positional: args.positional,
    flags: innerFlags,
    multiFlags: args.multiFlags,
    ...(args.globalCwd ? { globalCwd: args.globalCwd } : {}),
  };
  return runWatchLoop(
    { cwd, debounce, once, paths },
    {
      snapshot: async (): Promise<void> => {
        const ts = new Date().toLocaleTimeString();
        process.stdout.write(`\n[watch] ${ts}\n`);
        await runner(innerArgs);
      },
    },
  );
}
