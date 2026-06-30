import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeImport } from '../index.ts';

function tmpFile(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sc-reimport-'));
  const file = join(dir, name);
  writeFileSync(file, body);
  return file;
}

describe('safeImport re-import of an errored module', () => {
  test('a module that throws on evaluation reports ok=false on EVERY import', async () => {
    // The `default` export models the real crash: after the first import
    // errors the module in Bun's registry, a second import() hands back a
    // namespace whose `default` binding sits in the TDZ. Without the
    // process-scoped error memory, the second import was reported ok=true and
    // a later `mod.default` read threw `Cannot access default before
    // initialization` outside any try/catch.
    const file = tmpFile(
      'throws.ts',
      'throw new Error("boom at top level");\nexport default 1;\n',
    );

    const first = await safeImport(file, { skipExistsCheck: true });
    expect(first.ok).toBe(false);

    const second = await safeImport(file, { skipExistsCheck: true });
    expect(second.ok).toBe(false);

    if (!first.ok && !second.ok) {
      expect(first.timedOut).toBe(false);
      expect(second.timedOut).toBe(false);
      expect(first.error.message).toMatch(/boom at top level/);
      // The second import must surface the SAME evaluation error, not a
      // spuriously-ok namespace.
      expect(second.error.message).toBe(first.error.message);
    }

    rmSync(file, { force: true });
  });

  test('the cached failure short-circuits — no second module evaluation', async () => {
    const file = tmpFile('throws2.ts', 'throw new Error("kaboom");\n');

    const first = await safeImport(file, { skipExistsCheck: true });
    expect(first.ok).toBe(false);

    const t0 = Date.now();
    const second = await safeImport(file, { skipExistsCheck: true });
    const elapsed = Date.now() - t0;
    expect(second.ok).toBe(false);
    // Returned from the process-scoped error map, so essentially free.
    expect(elapsed).toBeLessThan(200);
    if (!second.ok) {
      expect(second.error.message).toMatch(/kaboom/);
    }

    rmSync(file, { force: true });
  });
});
