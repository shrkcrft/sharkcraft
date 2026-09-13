/**
 * Round 11 §3.6 / §1.4#a — the MCP helper tools read the ONE helper catalog
 * (built-in ∪ pack/local), and the pack tools settle in a long-lived process
 * even when a helper file is broken (a second import of a module that failed
 * to build used to hang forever). Read-only, real registries.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '../tools/index.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

const PACK_HELPER = `export default [{
  id: 'r75.add-route',
  title: 'Add route',
  description: 'Register a route',
  variables: [{ name: 'name', required: true, description: 'route name' }],
  operations: [{ kind: 'append-line', targetPath: 'src/routes.ts', snippet: "export const {{name}} = 1;", description: 'register' }],
  safety: { outputKind: 'plan' },
}];\n`;

function consumer(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-mcp-helpers-'));
  roots.push(root);
  write(root, 'package.json', JSON.stringify({ name: 'consumer', version: '0.0.0' }));
  write(root, 'sharkcraft/sharkcraft.config.ts', "export default { projectName: 'consumer' };\n");
  const pack = join(root, 'node_modules', '@r75', 'helpers');
  write(pack, 'package.json', JSON.stringify({ name: '@r75/helpers', version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }));
  write(
    pack,
    'manifest.json',
    JSON.stringify({
      schema: 'sharkcraft.pack/v1',
      info: { name: '@r75/helpers', version: '0.0.1' },
      contributions: { helperFiles: ['./helpers.ts', './helpers-broken.ts'] },
    }),
  );
  write(pack, 'helpers.ts', PACK_HELPER);
  write(pack, 'helpers-broken.ts', `export default [{ id: 'x', tags: ['a' 'b'] }];\n`);
  return root;
}

const tool = (name: string) => {
  const t = ALL_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

async function within<T>(ms: number, p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`still pending after ${ms}ms`)), ms)),
  ]);
}

describe('MCP helper tools read the one catalog', () => {
  test('list_helpers / get_helper see the pack helper; preview_helper_plan returns a plan, not the throw text', async () => {
    const root = consumer();
    const inspection = await inspectSharkcraft({ cwd: root });
    const ctx = { inspection, cwd: root };
    const list = await tool('list_helpers').handler({}, ctx);
    expect((list.data as { id: string }[]).map((h) => h.id)).toContain('r75.add-route');
    const get = await tool('get_helper').handler({ id: 'r75.add-route' }, ctx);
    expect((get.data as { source: string }).source).toBe('pack');
    const plan = await tool('preview_helper_plan').handler({ id: 'r75.add-route', vars: { name: 'users' } }, ctx);
    expect(plan.text ?? '').not.toContain('No built-in helpers');
    expect((plan.data as { ops: { snippet: string }[] }).ops[0]!.snippet).toBe('export const users = 1;');
  });

  test('list_pack_helpers then get_pack_helper, with a broken helper file, both settle', async () => {
    const root = consumer();
    const inspection = await inspectSharkcraft({ cwd: root });
    const ctx = { inspection, cwd: root };
    const first = await within(5000, Promise.resolve(tool('list_pack_helpers').handler({}, ctx)));
    expect((first.data as { helper: { id: string } }[]).map((e) => e.helper.id)).toEqual(['r75.add-route']);
    const second = await within(5000, Promise.resolve(tool('get_pack_helper').handler({ id: 'r75.add-route' }, ctx)));
    expect(second.isError ?? false).toBe(false);
  });

  test('get_pack_contributions is the async inventory: the broken file is a load failure', async () => {
    const root = consumer();
    const inspection = await inspectSharkcraft({ cwd: root });
    const r = await tool('get_pack_contributions').handler({}, { inspection, cwd: root });
    const data = r.data as { loadFailures: { file: string }[]; mode: string };
    expect(data.mode).toBe('async');
    expect(data.loadFailures.map((f) => f.file)).toEqual(['node_modules/@r75/helpers/helpers-broken.ts']);
  });
});
