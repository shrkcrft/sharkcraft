import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '@shrkcrft/graph';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '../tools/index.ts';

// beta + gamma both import + call `shared` from alpha → `shared` is the top
// symbol hub (2 distinct dependents) and alpha/index.ts the top file hub.
function setupFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-graph-hubs-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo-root', workspaces: ['packages/*'] }));
  for (const [name, body] of [
    ['alpha', 'export function shared() { return 1; }'],
    ['beta', "import { shared } from '@demo/alpha';\nexport const b = shared();"],
    ['gamma', "import { shared } from '@demo/alpha';\nexport const g = shared();"],
  ] as const) {
    mkdirSync(join(root, 'packages', name, 'src'), { recursive: true });
    writeFileSync(join(root, 'packages', name, 'package.json'), JSON.stringify({ name: `@demo/${name}`, main: 'src/index.ts' }));
    writeFileSync(join(root, 'packages', name, 'src', 'index.ts'), body);
  }
  return root;
}

async function ctxFor(root: string) {
  return { cwd: root, inspection: await inspectSharkcraft({ cwd: root }) };
}

const tool = () => ALL_TOOLS.find((t) => t.name === 'get_graph_hubs')!;

describe('get_graph_hubs MCP tool', () => {
  test('is registered, read-only, mirrors the CLI sibling', () => {
    const t = tool();
    expect(t).toBeDefined();
    expect(t.description.toLowerCase()).toContain('read-only');
    expect(t.cliCommand).toBe('graph hubs');
  });

  test('errors when the graph index is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-graph-hubs-empty-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x' }));
      const ctx = await ctxFor(root);
      const res = tool().handler({}, ctx) as { isError?: boolean; error?: { code: string } };
      expect(res.isError).toBe(true);
      expect(res.error?.code).toBe('graph-missing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ranks the most-depended-on symbol by distinct dependents', async () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const ctx = await ctxFor(root);
      const res = tool().handler({ limit: 10 }, ctx) as {
        data: { symbols: Array<{ label: string; inDegree: number }>; files: Array<{ path?: string; inDegree: number }> };
      };
      const shared = res.data.symbols.find((s) => s.label === 'shared');
      expect(shared?.inDegree).toBe(2);
      const alphaFile = res.data.files.find((f) => f.path?.includes('alpha'));
      expect(alphaFile?.inDegree).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
