/**
 * Round 11 §3.6 fix #3 — "a contributed plane that loads, validates, and is
 * unreachable": the pack-helper loader existed, validated and de-duplicated,
 * the contributions inventory read it — and NOTHING else did, so `helper list`
 * printed zero forever. Build-time guard: every registry loader the inventory
 * reaches must be imported by at least one other (non-test) source file, or be
 * listed below as deliberately inventory-only.
 *
 * Round 12 (12.1): the inventory reaches every registry loader through THE
 * rejection channel's loader table (`contribution-load-failures.ts`), so the
 * scan covers both files — a loader consumed only by them is still an orphan.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC = resolve(import.meta.dir, '..');
const INVENTORY = 'pack-contributions-inventory.ts';
/** The files through which the inventory reaches the registry loaders. */
const REACHERS: readonly string[] = [INVENTORY, 'contribution-load-failures.ts'];
/** Loaders whose only consumer is the inventory, on purpose. Empty today. */
const INVENTORY_ONLY: ReadonlySet<string> = new Set<string>();

describe('every loader the inventory reaches has a non-inventory consumer', () => {
  test('each imported registry module is imported somewhere else too', () => {
    const loaders = [
      ...new Set(
        REACHERS.flatMap((f) =>
          [...readFileSync(join(SRC, f), 'utf8').matchAll(/from '\.\/([\w-]+-registry)\.ts'/g)].map((m) => m[1]!),
        ),
      ),
    ];
    expect(loaders.length).toBeGreaterThanOrEqual(5);
    const others = readdirSync(SRC)
      .filter((f) => f.endsWith('.ts') && !REACHERS.includes(f))
      .map((f) => ({ f, text: readFileSync(join(SRC, f), 'utf8') }));
    for (const loader of loaders) {
      if (INVENTORY_ONLY.has(loader)) continue;
      const consumers = others
        .filter(({ f, text }) => f !== `${loader}.ts` && text.includes(`from './${loader}.ts'`))
        .map(({ f }) => f);
      expect({ loader, hasConsumer: consumers.length > 0 }).toEqual({ loader, hasConsumer: true });
    }
  });

  test('the pack-helper loader in particular is reached by the helper catalog `helper list` reads', () => {
    const catalog = readFileSync(join(SRC, 'helper-catalog.ts'), 'utf8');
    expect(catalog).toContain(`from './pack-helper-registry.ts'`);
  });
});
