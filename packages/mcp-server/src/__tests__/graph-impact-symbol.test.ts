import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '@shrkcrft/graph';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '../tools/index.ts';

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-impact-sym-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
  const pkgs: Array<[string, string]> = [
    ['alpha', 'export function shared() { return 1; }\nexport interface IStore { get(): number; }'],
    ['beta', "import { shared } from '@demo/alpha';\nexport const b = shared();"],
    // gamma implements IStore via a TYPE-ONLY import — no value-reference edge.
    ['gamma', "import type { IStore } from '@demo/alpha';\nexport class MemStore implements IStore { get() { return 1; } }"],
  ];
  for (const [name, body] of pkgs) {
    mkdirSync(join(root, 'packages', name, 'src'), { recursive: true });
    writeFileSync(join(root, 'packages', name, 'package.json'), JSON.stringify({ name: `@demo/${name}`, main: 'src/index.ts' }));
    writeFileSync(join(root, 'packages', name, 'src', 'index.ts'), body);
  }
  return root;
}

async function ctxFor(root: string) {
  return { cwd: root, inspection: await inspectSharkcraft({ cwd: root }) };
}

const impact = () => ALL_TOOLS.find((t) => t.name === 'get_graph_impact')!;

describe('get_graph_impact — symbol anchors', () => {
  test('returns dependents for a SYMBOL (was empty: importersOf is empty for symbols)', async () => {
    const root = setup();
    try {
      buildFullIndex({ projectRoot: root });
      const ctx = await ctxFor(root);
      const res = impact().handler({ target: 'shared' }, ctx) as {
        data: { directDependents: Array<{ path?: string }> };
      };
      expect(res.data.directDependents.length).toBeGreaterThan(0);
      expect(res.data.directDependents.some((d) => d.path?.includes('beta'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('includes a type-only-import implementer in an interface\'s impact', async () => {
    const root = setup();
    try {
      buildFullIndex({ projectRoot: root });
      const ctx = await ctxFor(root);
      const res = impact().handler({ target: 'IStore' }, ctx) as {
        data: { directDependents: Array<{ path?: string }> };
      };
      // gamma implements IStore via `import type` — it breaks if IStore changes.
      expect(res.data.directDependents.some((d) => d.path?.includes('gamma'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
