/**
 * r76 — the MCP boundary-rule reads carry THE rejection channel (round 12
 * review, R12-X5).
 *
 * A pack boundary rule its loader refuses (a negation-only `from`) is not in
 * the registry, so `list_boundary_rules` simply lacked it and
 * `get_boundary_rule` answered a bare "not found" — while `shrk boundaries
 * list` printed `⚠ 1 entry rejected from <file>: '<id>' … — from: …`. The list
 * now carries the same note as its text (the rows array is unchanged, as the
 * CLI keeps its `--json` stdout parseable), and `get_boundary_rule` answers a
 * rejected id with `error.code: "rejected"` and every reason. Output-only: the
 * input schemas (and the strict wire validator) are unchanged.
 *
 * A real temp workspace, a real pack under node_modules, a real inspection and
 * the real registered handlers.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '../tools/all-tools.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const tool = (name: string) => {
  const t = ALL_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`MCP tool ${name} is not registered`);
  return t;
};

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r76-mcp-bd-rej-'));
  roots.push(root);
  write(root, 'package.json', JSON.stringify({ name: 'fx', version: '0.0.0' }));
  write(root, 'sharkcraft/sharkcraft.config.ts', "export default { projectName: 'fx' };\n");
  write(root, 'src/a.ts', "import x from 'lodash';\nexport const a = x;\n");
  const dir = 'node_modules/@r76/bd';
  write(root, `${dir}/package.json`, JSON.stringify({ name: '@r76/bd', version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }));
  write(
    root,
    `${dir}/manifest.json`,
    JSON.stringify({ schema: 'sharkcraft.pack/v1', info: { name: '@r76/bd', version: '0.0.1' }, contributions: { boundaryFiles: ['./boundaries.ts'] } }),
  );
  write(
    root,
    `${dir}/boundaries.ts`,
    "export default [\n  { id: 'pk-bd-ok', title: 'OK', from: ['src/**'], forbiddenImports: ['left-pad'] },\n  { id: 'pk-bd-negonly', title: 'Neg only', from: ['!src/**'], forbiddenImports: ['lodash'] },\n];\n",
  );
  return root;
}

describe('R12-X5 — a rejected pack boundary rule stays in the agent\'s view', () => {
  test('list_boundary_rules: the rows are the registered rules; the text names the rejected one with its reason', async () => {
    const root = workspace();
    const inspection = await inspectSharkcraft({ cwd: root });
    const res = await tool('list_boundary_rules').handler({}, { inspection, cwd: root });
    const rows = res.data as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual(['pk-bd-ok']);
    expect(res.text).toContain("⚠ 1 entry rejected from node_modules/@r76/bd/boundaries.ts: 'pk-bd-negonly' (default[1]) — from:");
  }, 60_000);

  test('get_boundary_rule: a rejected id answers "rejected" with every reason — never a bare not-found', async () => {
    const root = workspace();
    const inspection = await inspectSharkcraft({ cwd: root });
    const ctx = { inspection, cwd: root };
    const rejected = await tool('get_boundary_rule').handler({ id: 'pk-bd-negonly' }, ctx);
    expect(rejected.isError).toBe(true);
    expect(rejected.error?.code).toBe('rejected');
    const details = rejected.error?.details as { rejections: { file: string; index: number; reasons: string[]; packageName: string | null }[] };
    expect(details.rejections).toHaveLength(1);
    expect(details.rejections[0]).toMatchObject({ file: 'node_modules/@r76/bd/boundaries.ts', index: 1, packageName: '@r76/bd' });
    expect(details.rejections[0]!.reasons.join('; ')).toContain('from');
    expect(rejected.text).toContain('REJECTED');

    const missing = await tool('get_boundary_rule').handler({ id: 'nope' }, ctx);
    expect(missing.isError).toBe(true);
    expect(missing.error).toBeUndefined();
    expect(missing.text).toBe('No boundary rule with id "nope".');

    const ok = await tool('get_boundary_rule').handler({ id: 'pk-bd-ok' }, ctx);
    expect((ok.data as { id: string }).id).toBe('pk-bd-ok');
  }, 60_000);
});
