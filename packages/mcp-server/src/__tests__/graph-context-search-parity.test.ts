import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '@shrkcrft/graph';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '../tools/index.ts';

// alpha declares `shared` + `IStore`; beta calls shared(); gamma type-only
// implements IStore. Mirrors the impact-symbol fixture so the context/search
// MCP tools are exercised against the same wiring the CLI sees.
function setup(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-ctx-search-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
  const pkgs: Array<[string, string]> = [
    ['alpha', 'export function shared() { return 1; }\nexport interface IStore { get(): number; }'],
    ['beta', "import { shared } from '@demo/alpha';\nexport const b = shared();"],
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

const tool = (name: string) => ALL_TOOLS.find((t) => t.name === name)!;

describe('get_graph_context — symbol anchors (parity with CLI)', () => {
  test('a SYMBOL anchor reports its declaring file imports + who uses it (was empty)', async () => {
    const root = setup();
    try {
      buildFullIndex({ projectRoot: root });
      const ctx = await ctxFor(root);
      const res = tool('get_graph_context').handler({ target: 'shared' }, ctx) as {
        data: {
          declaredIn?: { path?: string };
          importedBy: Array<{ path?: string }>;
          calledBy?: Array<{ path?: string }>;
        };
      };
      // Declaring file resolved (symbols carry no imports-file edges themselves).
      expect(res.data.declaredIn?.path).toContain('alpha');
      // importedBy reflects the declaring FILE's importers — beta + gamma both
      // import alpha. Previously empty for every symbol anchor.
      expect(res.data.importedBy.some((n) => n.path?.includes('beta'))).toBe(true);
      // calledBy surfaces the actual call site — beta calls shared().
      expect(res.data.calledBy?.some((n) => n.path?.includes('beta'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('get_graph_search — fuzzy file fallback (parity with CLI)', () => {
  test('a bare basename fragment finds files by substring (was empty)', async () => {
    const root = setup();
    try {
      buildFullIndex({ projectRoot: root });
      const ctx = await ctxFor(root);
      const res = tool('get_graph_search').handler({ query: 'index', kind: 'file' }, ctx) as {
        data: { matches: Array<{ path?: string }> };
      };
      // Three index.ts files — fuzzy substring matches all of them; an exact
      // path lookup alone would have returned nothing for the bare fragment.
      expect(res.data.matches.length).toBeGreaterThan(1);
      expect(res.data.matches.every((m) => m.path?.endsWith('index.ts'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('exact:true suppresses the fuzzy fallback', async () => {
    const root = setup();
    try {
      buildFullIndex({ projectRoot: root });
      const ctx = await ctxFor(root);
      const res = tool('get_graph_search').handler({ query: 'index', kind: 'file', exact: true }, ctx) as {
        data: { matches: Array<{ path?: string }> };
      };
      // No exact file path equals "index" → no fuzzy fallback → empty.
      expect(res.data.matches.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
