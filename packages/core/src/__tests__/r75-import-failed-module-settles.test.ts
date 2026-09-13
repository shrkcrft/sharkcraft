import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importModuleViaLoader, safeImport } from '../index.ts';

/**
 * A module that failed to BUILD (a hard syntax error) must never produce a
 * never-settling second import. In Bun the second `import()` of such a module
 * stays pending forever: the event loop drains, a CLI verb exits 0 with no
 * output, and a long-lived MCP server hangs. `importModuleViaLoader` is the one
 * authority for "this module already failed in this process"; `safeImport`
 * inherits it.
 */

// `['a' 'b']` is a syntax error: the file fails to build, not merely to evaluate.
const BROKEN = "export default { tags: ['a' 'b'] };\n";
const SETTLE_MS = 1000;

const dirs: string[] = [];
function brokenFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sc-r75-settle-'));
  dirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, BROKEN);
  return file;
}

interface ISettled {
  state: 'resolved' | 'rejected' | 'pending';
  message?: string;
  elapsedMs: number;
}

/** Race an import against a deadline; a never-settling import reports `pending`. */
async function settleWithin(p: Promise<unknown>, ms: number): Promise<ISettled> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ISettled>((resolve) => {
    timer = setTimeout(() => resolve({ state: 'pending', elapsedMs: Date.now() - t0 }), ms);
  });
  const outcome = p.then(
    (): ISettled => ({ state: 'resolved', elapsedMs: Date.now() - t0 }),
    (e: unknown): ISettled => ({
      state: 'rejected',
      message: e instanceof Error ? e.message : String(e),
      elapsedMs: Date.now() - t0,
    }),
  );
  const result = await Promise.race([outcome, deadline]);
  if (timer) clearTimeout(timer);
  return result;
}

describe('a module that failed to build settles on every later import', () => {
  test('importModuleViaLoader twice: the second call rejects fast with the original message', async () => {
    const file = brokenFile('twice.ts');
    const first = await settleWithin(importModuleViaLoader(file), SETTLE_MS);
    expect(first.state).toBe('rejected');
    expect(first.message).toBeTruthy();

    const second = await settleWithin(importModuleViaLoader(file), SETTLE_MS);
    expect(second.state).toBe('rejected');
    expect(second.message).toBe(first.message);
    expect(second.elapsedMs).toBeLessThan(SETTLE_MS);
  });

  test('safeImport then importModuleViaLoader: the loader rejects instead of hanging', async () => {
    // The release-check shape: the surface-gate inspection imports the broken
    // file through safeImport, then a later verb re-imports it directly.
    const file = brokenFile('safe-first.ts');
    const viaSafe = await safeImport(file);
    expect(viaSafe.ok).toBe(false);
    if (viaSafe.ok) return;
    expect(viaSafe.timedOut).toBe(false);

    const viaLoader = await settleWithin(importModuleViaLoader(file), SETTLE_MS);
    expect(viaLoader.state).toBe('rejected');
    expect(viaLoader.message).toBe(viaSafe.error.message);
  });

  test('importModuleViaLoader then safeImport: safeImport reports the same failure, not a timeout', async () => {
    const file = brokenFile('loader-first.ts');
    const viaLoader = await settleWithin(importModuleViaLoader(file), SETTLE_MS);
    expect(viaLoader.state).toBe('rejected');

    const t0 = Date.now();
    const viaSafe = await safeImport(file, { timeoutMs: 5000 });
    expect(Date.now() - t0).toBeLessThan(SETTLE_MS);
    expect(viaSafe.ok).toBe(false);
    if (viaSafe.ok) return;
    expect(viaSafe.timedOut).toBe(false);
    expect(viaSafe.error.message).toBe(viaLoader.message!);
  });

  test('two CONCURRENT imports of the broken module both reject', async () => {
    // The concurrent second import used to stay pending too: it starts before
    // the first attempt's failure is known, so it must share that attempt.
    const file = brokenFile('concurrent.ts');
    const [a, b] = await Promise.all([
      settleWithin(importModuleViaLoader(file), SETTLE_MS),
      settleWithin(importModuleViaLoader(file), SETTLE_MS),
    ]);
    expect(a.state).toBe('rejected');
    expect(b.state).toBe('rejected');
    expect(b.message).toBe(a.message);
  });

  test('a file that did not exist is not remembered — creating it later still loads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc-r75-settle-'));
    dirs.push(dir);
    const file = join(dir, 'later.ts');
    const missing = await settleWithin(importModuleViaLoader(file), SETTLE_MS);
    expect(missing.state).toBe('rejected');

    writeFileSync(file, 'export default 42;\n');
    const mod = await importModuleViaLoader<{ default: number }>(file);
    expect(mod.default).toBe(42);
  });

  test('cleanup', () => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
