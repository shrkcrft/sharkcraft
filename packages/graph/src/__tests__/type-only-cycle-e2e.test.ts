import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '../indexer/index-builder.ts';
import { GraphQueryApi } from '../query/query-api.ts';

/**
 * End-to-end lock for the `--include-type-edges` cycle flag over REAL source.
 *
 * The §2.3 divergence tests in `cycle-detection.test.ts` synthesize
 * `data.typeOnly` edges by hand. This fixture instead writes two source files
 * whose ONLY link is a mutual `import type` (a pure interface↔interface loop)
 * and runs them through the FULL extractor → index-builder → cycle path
 * (`buildFullIndex` → `summarizeCycles` in the manifest, `findFileCycles` via
 * `GraphQueryApi.cycles`). It proves the `isTypeOnly` flag really flows from a
 * real `import type` source line all the way to an excluded runtime cycle:
 * default cycle count is 0 while the opt-in `includeTypeEdges` count is 1.
 */
describe('type-only cycle exclusion — end-to-end from real source', () => {
  test('a pure `import type` interface↔interface loop is excluded by default, present only with includeTypeEdges', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-graph-typeonly-e2e-'));
    try {
      // a.ts and b.ts reference each other's interfaces, each via `import type`.
      // Both ImportsFile edges are erased at emit time → no runtime cycle.
      writeFileSync(
        join(root, 'a.ts'),
        ["import type { X } from './b';", 'export interface Y {', '  x: X;', '}'].join('\n'),
      );
      writeFileSync(
        join(root, 'b.ts'),
        ["import type { Y } from './a';", 'export interface X {', '  y: Y;', '}'].join('\n'),
      );

      const { manifest } = buildFullIndex({ projectRoot: root });
      // Both files are indexed and the a↔b import edges exist.
      expect(manifest.filesIndexed).toBe(2);

      // summarizeCycles (default, runtime) sees no cycle — type-only edges dropped.
      expect(manifest.cycleCount).toBe(0);
      // The compile-time loop is surfaced in the non-blocking bucket instead.
      expect(manifest.typeOnlyLoopCount).toBe(1);

      const q = GraphQueryApi.fromStore(root);

      // Default findFileCycles view: the type-only edges are excluded → 0 cycles.
      const defaultCycles = q.cycles();
      expect(defaultCycles).toHaveLength(0);

      // Opt-in audit view: the type edges close the A↔B loop → exactly 1 cycle of size 2.
      const optInCycles = q.cycles({ includeTypeEdges: true });
      expect(optInCycles).toHaveLength(1);
      expect(optInCycles[0]!.size).toBe(2);
      expect([...(optInCycles[0]!.paths ?? [])].sort()).toEqual(['a.ts', 'b.ts']);

      // The load-bearing divergence, proven on REAL source: default < opt-in.
      expect(defaultCycles.length).toBeLessThan(optInCycles.length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
