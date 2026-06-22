import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '@shrkcrft/graph';
import { buildDashboardCodeIntelligence } from '../dashboard/code-intelligence-data.ts';

// alpha exports `shared`; beta and gamma both import + call it → `shared` is the
// top hub (2 distinct dependents) and alpha/index.ts the top file (2 importers).
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-ci-hubs-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo-root', workspaces: ['packages/*'] }, null, 2),
  );
  for (const [name, body] of [
    ['alpha', 'export function shared() { return 1; }'],
    ['beta', "import { shared } from '@demo/alpha';\nexport const b = shared();"],
    ['gamma', "import { shared } from '@demo/alpha';\nexport const g = shared();"],
  ] as const) {
    mkdirSync(join(root, 'packages', name, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'packages', name, 'package.json'),
      JSON.stringify({ name: `@demo/${name}`, main: 'src/index.ts' }, null, 2),
    );
    writeFileSync(join(root, 'packages', name, 'src', 'index.ts'), body);
  }
  return root;
}

describe('buildDashboardCodeIntelligence — hubs + freshness', () => {
  test('reports load-bearing hubs and a fresh index right after indexing', () => {
    const root = fixture();
    try {
      buildFullIndex({ projectRoot: root });
      const d = buildDashboardCodeIntelligence(root);
      expect(d.graph.available).toBe(true);

      // Freshness: nothing changed since the index → fresh, zero drift.
      expect(d.graph.freshness?.state).toBe('fresh');
      expect(d.graph.freshness?.modified).toBe(0);

      // Hubs: `shared` is referenced by two distinct files.
      const shared = d.graph.hubs?.symbols.find((h) => h.label === 'shared');
      expect(shared?.inDegree).toBe(2);
      // alpha/index.ts is imported by two distinct files.
      const alphaFile = d.graph.hubs?.files.find((h) => h.path?.includes('alpha'));
      expect(alphaFile?.inDegree).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('flags the index stale after an on-disk edit', () => {
    const root = fixture();
    try {
      buildFullIndex({ projectRoot: root });
      // Touch a file AFTER indexing → the freshness walk must see drift.
      writeFileSync(join(root, 'packages', 'beta', 'src', 'index.ts'), "export const b = 99;\n");
      const d = buildDashboardCodeIntelligence(root);
      expect(d.graph.freshness?.state).toBe('stale');
      expect((d.graph.freshness?.modified ?? 0) + (d.graph.freshness?.deleted ?? 0)).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
