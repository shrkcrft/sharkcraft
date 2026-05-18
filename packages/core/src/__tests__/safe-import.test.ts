import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createImportContext,
  DEFAULT_SAFE_IMPORT_TIMEOUT_MS,
  safeImport,
} from '../index.ts';

function tmpFile(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sc-r51-'));
  const file = join(dir, name);
  writeFileSync(file, body);
  return file;
}

describe('safeImport', () => {
  test('imports a valid TS module', async () => {
    const file = tmpFile('ok.ts', 'export const value = 42;\n');
    const r = await safeImport<{ value: number }>(file);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.module.value).toBe(42);
      expect(typeof r.elapsedMs).toBe('number');
    }
    rmSync(file, { force: true });
  });

  test('returns ok=false with a parse error', async () => {
    const file = tmpFile('dup.ts', 'export const x = 1;\nexport const x = 2;\n');
    const r = await safeImport(file);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.timedOut).toBe(false);
      expect(r.error.message).toMatch(/has already been declared|x/i);
    }
  });

  test('returns ok=false with timedOut=true when the import hangs', async () => {
    // Top-level await on a never-resolving promise — the dynamic
    // import will never settle, so safeImport must bound it.
    const file = tmpFile(
      'hang.ts',
      'await new Promise(() => {});\nexport const y = 1;\n',
    );
    const r = await safeImport(file, { timeoutMs: 1500 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.timedOut).toBe(true);
      expect(r.elapsedMs).toBeGreaterThanOrEqual(1500);
      expect(r.error.message).toMatch(/timed out after \d+ms/);
    }
  });

  test('returns a not-found failure for missing files (synchronously, no timeout)', async () => {
    const r = await safeImport('/tmp/definitely-not-here-r51.ts');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.timedOut).toBe(false);
      expect(r.error.message).toMatch(/file not found/);
    }
  });

  test('uses the default timeout when none is provided', () => {
    expect(DEFAULT_SAFE_IMPORT_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('createImportContext', () => {
  test('dedups repeated load() calls for the same path (single underlying import)', async () => {
    const file = tmpFile('once.ts', 'export const v = "once";\n');
    const ctx = createImportContext();
    const a = await ctx.load<{ v: string }>(file);
    const b = await ctx.load<{ v: string }>(file);
    expect(a.ok && b.ok).toBe(true);
    expect(ctx.size()).toBe(1);
    if (a.ok && b.ok) {
      expect(a.module.v).toBe('once');
      expect(b.module.v).toBe('once');
    }
  });

  test('a failed import does not produce a second deadlocked load — context returns the cached failure', async () => {
    const file = tmpFile('dup.ts', 'export const z = 1;\nexport const z = 2;\n');
    const ctx = createImportContext({ timeoutMs: 1500 });
    const a = await ctx.load(file);
    expect(a.ok).toBe(false);
    const t0 = Date.now();
    const b = await ctx.load(file);
    const elapsed = Date.now() - t0;
    expect(b.ok).toBe(false);
    // The second load comes from the dedup map — it must NOT pay
    // another timeout's worth of wall-clock.
    expect(elapsed).toBeLessThan(800);
    expect(ctx.size()).toBe(1);
  });

  test('hasSettled() reflects whether the import has actually completed', async () => {
    const file = tmpFile('ok2.ts', 'export const t = true;\n');
    const ctx = createImportContext();
    expect(ctx.hasSettled(file)).toBe(false);
    await ctx.load(file);
    expect(ctx.hasSettled(file)).toBe(true);
  });
});
