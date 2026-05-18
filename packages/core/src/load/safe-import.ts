import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface ISafeImportSuccess<T = Record<string, unknown>> {
  ok: true;
  module: T;
  elapsedMs: number;
}

export interface ISafeImportFailure {
  ok: false;
  error: Error;
  elapsedMs: number;
  timedOut: boolean;
}

export type SafeImportResult<T = Record<string, unknown>> =
  | ISafeImportSuccess<T>
  | ISafeImportFailure;

export interface ISafeImportOptions {
  /** Max ms to wait for the dynamic import before timing out. */
  timeoutMs?: number;
  /** Skip the existsSync pre-check (caller already verified). */
  skipExistsCheck?: boolean;
}

export const DEFAULT_SAFE_IMPORT_TIMEOUT_MS = 8000;

export async function safeImport<T = Record<string, unknown>>(
  filePath: string,
  options: ISafeImportOptions = {},
): Promise<SafeImportResult<T>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SAFE_IMPORT_TIMEOUT_MS;
  const start = Date.now();

  if (!options.skipExistsCheck && !existsSync(filePath)) {
    return {
      ok: false,
      error: new Error(`file not found: ${filePath}`),
      elapsedMs: Date.now() - start,
      timedOut: false,
    };
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<SafeImportResult<T>>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        ok: false,
        error: new Error(
          `import timed out after ${timeoutMs}ms: ${filePath}`,
        ),
        elapsedMs: Date.now() - start,
        timedOut: true,
      });
    }, timeoutMs);
    if (timer && typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref?: () => void }).unref!();
    }
  });

  const importPromise = (async (): Promise<SafeImportResult<T>> => {
    try {
      const mod = (await import(pathToFileURL(filePath).href)) as T;
      return { ok: true, module: mod, elapsedMs: Date.now() - start };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e : new Error(String(e)),
        elapsedMs: Date.now() - start,
        timedOut: false,
      };
    }
  })();

  const result = await Promise.race([importPromise, timeoutPromise]);
  if (timer) clearTimeout(timer);
  return result;
}
