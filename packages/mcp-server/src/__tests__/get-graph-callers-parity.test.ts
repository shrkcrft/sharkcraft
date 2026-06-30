import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '@shrkcrft/graph';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '../tools/index.ts';

// alpha declares shared()/solo()/dup(); beta calls shared() once and solo()
// TWICE in one file (two sites collapse to one caller-file edge); gamma is a
// SECOND distinct caller file of shared(); delta declares a SECOND dup() so the
// name is ambiguous. Mirrors the CLI `graph callers` wiring so the MCP tool is
// exercised against the same shape the CLI sees.
function setup(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-callers-parity-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
  const pkgs: Array<[string, string]> = [
    [
      'alpha',
      'export function shared() { return 1; }\nexport function solo() { return 2; }\nexport function dup() { return 3; }',
    ],
    ['beta', "import { shared, solo } from '@demo/alpha';\nexport const b = shared() + solo() + solo();"],
    ['gamma', "import { shared } from '@demo/alpha';\nexport const g = shared();"],
    ['delta', 'export function dup() { return 4; }'],
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

describe('get_graph_callers — note parity with CLI graph callers', () => {
  test('two call sites in one file collapse: total = distinct caller FILES + dedup note', async () => {
    const root = setup();
    try {
      buildFullIndex({ projectRoot: root });
      const ctx = await ctxFor(root);
      // solo() is called twice inside beta/src/index.ts — the two sites collapse
      // to a single caller-file edge at index time, so `total` is 1.
      const res = tool('get_graph_callers').handler({ symbol: 'solo', mode: 'call', format: 'json' }, ctx) as {
        data: { total: number; note?: string; callers: Array<{ path?: string }> };
      };
      expect(res.data.total).toBe(1);
      expect(res.data.callers.length).toBe(1);
      // The note explains that `total` counts distinct caller FILES — the gap
      // that made an agent read `total` as a raw invocation count and
      // under-scope blast radius.
      expect(res.data.note).toContain('distinct caller files');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an ambiguous two-match name yields a note naming the chosen symbol', async () => {
    const root = setup();
    try {
      buildFullIndex({ projectRoot: root });
      const ctx = await ctxFor(root);
      // Two symbols named "dup" (alpha + delta). resolveSymbol silently picked
      // one before; now the note discloses the ambiguity AND names the chosen id.
      const res = tool('get_graph_callers').handler({ symbol: 'dup', mode: 'call', format: 'json' }, ctx) as {
        data: { symbol: { id: string; label: string }; note?: string };
      };
      expect(res.data.note).toContain('2 symbols named "dup"');
      // The note names the SPECIFIC chosen symbol so the agent never reads the
      // narrow result as the whole picture for that name.
      expect(res.data.note).toContain(res.data.symbol.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('limit caps the returned callers while total stays the true count', async () => {
    const root = setup();
    try {
      buildFullIndex({ projectRoot: root });
      const ctx = await ctxFor(root);
      // shared() has two distinct caller files (beta + gamma). limit:1 caps the
      // list but `total` must still report the real 2.
      const res = tool('get_graph_callers').handler(
        { symbol: 'shared', mode: 'call', limit: 1, format: 'json' },
        ctx,
      ) as { data: { total: number; limit: number; callers: Array<{ path?: string }> } };
      expect(res.data.total).toBe(2);
      expect(res.data.callers.length).toBe(1);
      expect(res.data.limit).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
