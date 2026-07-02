import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChangesSummary } from '../changes-summary.ts';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';

/**
 * §1.7 — area attribution should resolve from the declared taxonomy (boundary
 * `from` globs) and a generic monorepo package root, not bucket everything the
 * hardcoded SharkCraft prefixes miss into `unknown`.
 */
function setupRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-changes-area-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.0' }));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    ["export default {", "  projectName: 'demo',", "  boundaryFiles: ['boundaries.ts'],", "};"].join('\n'),
  );
  writeFileSync(
    join(root, 'sharkcraft', 'boundaries.ts'),
    [
      'export default [{',
      "  id: 'demo.backend',",
      "  title: 'backend layer',",
      "  severity: 'error',",
      "  from: ['services/api/**'],",
      "  forbiddenImports: ['@demo/ui'],",
      "  tags: ['backend'],",
      "  appliesWhen: ['review-code'],",
      '}];',
    ].join('\n'),
  );
  return root;
}

describe('changes summary — declared area attribution (§1.7)', () => {
  test('resolves declared boundary areas + generic package roots; only truly-unmapped files are unknown', async () => {
    const root = setupRepo();
    try {
      const inspection = await inspectSharkcraft({ cwd: root });
      const report = await buildChangesSummary(inspection, {
        files: ['services/api/handler.ts', 'packages/widget/src/w.ts', 'totally/random/file.ts'],
      });
      const areaOf = (p: string): string => report.files.find((f) => f.path === p)!.area;
      // Declared boundary glob → the rule's tag as the area.
      expect(areaOf('services/api/handler.ts')).toBe('backend');
      // Generic monorepo package root (not in the hardcoded prefix list).
      expect(areaOf('packages/widget/src/w.ts')).toBe('widget');
      // Genuinely unmapped → unknown, and counted as the self-diagnostic.
      expect(areaOf('totally/random/file.ts')).toBe('unknown');
      expect(report.unknownFiles).toBe(1);
      expect(report.unknownRate).toBeCloseTo(1 / 3, 5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
