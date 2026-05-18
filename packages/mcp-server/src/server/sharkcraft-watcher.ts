import { existsSync, watch, type FSWatcher } from 'node:fs';
import * as nodePath from 'node:path';

export interface StartWatcherOptions {
  cwd: string;
  /** Debounce window in ms. Default 200. */
  debounceMs?: number;
  onChange: (changedPath: string) => void | Promise<void>;
  log?: (line: string) => void;
}

export interface IWatcherHandle {
  stop: () => void;
}

/**
 * Watches `<cwd>/sharkcraft/` (recursive on macOS/Linux/Windows where supported).
 * Coalesces bursty events through a debounce. On any change, invokes onChange
 * once with the most-recent path. If `sharkcraft/` does not exist, the watcher
 * is a no-op (but still returns a stop()).
 */
export function startSharkcraftWatcher(options: StartWatcherOptions): IWatcherHandle {
  const debounceMs = options.debounceMs ?? 200;
  const log = options.log ?? (() => undefined);
  const sharkcraftDir = nodePath.join(options.cwd, 'sharkcraft');

  if (!existsSync(sharkcraftDir)) {
    log(`no sharkcraft/ directory at ${sharkcraftDir} — watcher disabled`);
    return { stop: () => undefined };
  }

  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPath = '';
  let stopped = false;

  function schedule(path: string): void {
    if (stopped) return;
    lastPath = path;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      Promise.resolve(options.onChange(lastPath)).catch((e) => {
        log(`onChange threw: ${(e as Error).message}`);
      });
    }, debounceMs);
  }

  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(sharkcraftDir, { recursive: true }, (event, filename) => {
      if (stopped) return;
      const filePath = filename ? nodePath.join(sharkcraftDir, filename.toString()) : sharkcraftDir;
      log(`event=${event} ${filePath}`);
      schedule(filePath);
    });
    log(`watching ${sharkcraftDir}`);
  } catch (e) {
    log(`failed to start watcher: ${(e as Error).message}`);
  }

  return {
    stop: () => {
      stopped = true;
      if (pendingTimer) clearTimeout(pendingTimer);
      try {
        watcher?.close();
      } catch {
        // ignore
      }
    },
  };
}
