import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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

// Bun reads TypeScript natively. Node does not (Node 22+ has experimental
// strip-types, but it is gated on a flag). When running on Node, route
// every `.ts` / `.tsx` / `.mts` / `.cts` import through jiti so dist-mode
// CLI invocations (`npx shrk …`) can load user-authored TypeScript config
// files (`sharkcraft.config.ts`, `sharkcraft/boundaries.ts`, etc.).
const isBun =
  typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' &&
  (globalThis as { Bun?: { version?: string } }).Bun?.version !== undefined;
const TS_FILE_RE = /\.(ts|tsx|mts|cts)$/i;

interface IJitiInstance {
  import<T = unknown>(id: string): Promise<T>;
}
let jitiInstance: IJitiInstance | null = null;
let jitiLoadAttempted = false;

async function getJiti(): Promise<IJitiInstance | null> {
  if (jitiInstance) return jitiInstance;
  if (jitiLoadAttempted) return null;
  jitiLoadAttempted = true;
  try {
    const mod = (await import('jiti')) as {
      createJiti?: (base: string, options?: Record<string, unknown>) => IJitiInstance;
      default?: (base: string, options?: Record<string, unknown>) => IJitiInstance;
    };
    const factory = mod.createJiti ?? mod.default;
    if (typeof factory !== 'function') return null;
    jitiInstance = factory(pathToFileURL(import.meta.url).href, {
      interopDefault: false,
    });
    return jitiInstance;
  } catch {
    return null;
  }
}

/**
 * Process-scoped memory of modules that failed to import — THE one authority
 * for "this module already failed in this process". Only
 * {@link importModuleViaLoader} reads or writes it; `safeImport` and every
 * registry loader inherit it by going through that function.
 *
 * The ESM module registry is frozen for the lifetime of a process, and a
 * second `import()` of a module that failed is never safe:
 *
 *   - a module that failed to BUILD (a syntax error) never settles on a second
 *     import in Bun — the promise stays pending forever, the event loop drains,
 *     and the process exits 0 with no output (or a long-lived MCP server hangs);
 *   - a module that threw during EVALUATION can hand back a partially
 *     initialized namespace whose bindings (e.g. `default`) sit in the temporal
 *     dead zone — reading them throws `Cannot access 'default' before
 *     initialization` far away from any try/catch.
 *
 * Remembering the original error turns both into a deterministic rejection
 * that carries the original message.
 */
const moduleEvaluationErrors = new Map<string, Error>();

/**
 * Imports currently in flight, keyed like {@link moduleEvaluationErrors}. A
 * CONCURRENT second import of a module that is failing to build never settles
 * either, so concurrent callers share the first attempt instead of racing it.
 */
const inflightImports = new Map<string, Promise<unknown>>();

async function importViaRuntime<T>(filePath: string): Promise<T> {
  if (!isBun && TS_FILE_RE.test(filePath)) {
    const jiti = await getJiti();
    if (jiti) return (await jiti.import<T>(filePath));
    // Fall through to native import — Node 22+ with --experimental-strip-types
    // can still resolve, otherwise the error surfaces to the caller.
  }
  return (await import(pathToFileURL(filePath).href)) as T;
}

/**
 * Bun-or-jiti-aware dynamic import. Use this anywhere the engine needs to
 * load a user-authored TypeScript file (config, knowledge, boundaries,
 * pipelines, etc.) from an absolute path. Falls back to native `import()`
 * for `.js` / `.mjs` so library consumers without TypeScript files pay
 * nothing.
 *
 * A module that already failed in this process rejects with its ORIGINAL
 * error — immediately, without touching the module registry again (see
 * {@link moduleEvaluationErrors}). A failure on a file that does not exist is
 * not remembered, so a file created later in the same process still loads.
 */
export async function importModuleViaLoader<T = Record<string, unknown>>(
  filePath: string,
): Promise<T> {
  const cacheKey = resolve(filePath);
  const priorError = moduleEvaluationErrors.get(cacheKey);
  if (priorError) throw priorError;

  const pending = inflightImports.get(cacheKey);
  if (pending) return (await pending) as T;

  const attempt = importViaRuntime<T>(filePath);
  inflightImports.set(cacheKey, attempt);
  try {
    return await attempt;
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    if (existsSync(filePath)) moduleEvaluationErrors.set(cacheKey, error);
    throw error;
  } finally {
    inflightImports.delete(cacheKey);
  }
}

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
      const mod = await importModuleViaLoader<T>(filePath);
      return { ok: true, module: mod, elapsedMs: Date.now() - start };
    } catch (e) {
      // importModuleViaLoader already remembered the failure (it is the one
      // authority), so a second import of this file rejects with this same
      // error instead of hanging or handing back a TDZ namespace.
      const error = e instanceof Error ? e : new Error(String(e));
      return {
        ok: false,
        error,
        elapsedMs: Date.now() - start,
        timedOut: false,
      };
    }
  })();

  const result = await Promise.race([importPromise, timeoutPromise]);
  if (timer) clearTimeout(timer);
  return result;
}
