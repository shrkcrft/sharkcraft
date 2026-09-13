/**
 * Round 11 review — `get_registry_lifecycle_report` reads the SAME config and
 * the SAME verdict authority as the two CLI lifecycle verbs.
 *
 *   - `offset` continues a capped scan: `data.nextOffset`, and a `Next:` hint
 *     naming `--offset <n>`;
 *   - `registryLifecycle.skipDirsAdd` from a REAL sharkcraft.config.ts reaches
 *     the scan (through `ctx.inspection.config`);
 *   - an EXISTING config that fails to load is never a pass. `config` is null
 *     then, and the scan used to fall back silently to the default skip set.
 *
 * Real temp workspaces and a real inspection (`inspectSharkcraft`) — never a
 * hand-built context or report.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft, type IRegistryLifecycleReport } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '../tools/all-tools.ts';
import type { IToolContext } from '../server/tool-definition.ts';

const tool = ALL_TOOLS.find((t) => t.name === 'get_registry_lifecycle_report');
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function workspace(config: Record<string, unknown>, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-lifecycle-mcp-'));
  roots.push(root);
  const write = (rel: string, body: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  write('package.json', JSON.stringify({ name: 'fx', version: '0.0.0' }));
  write('sharkcraft/sharkcraft.config.ts', `export default ${JSON.stringify({ projectName: 'fx', ...config })};\n`);
  for (const [rel, body] of Object.entries(files)) write(rel, body);
  return root;
}

const pair = (n: string): string =>
  `const m = new Map();\nexport function register${n}(id, x) { m.set(id, x); }\nexport function remove${n}(id) { m.delete(id); }\n`;
const miss = (n: string): string =>
  `const m = new Map();\nexport function register${n}(id, x) { m.set(id, x); }\nexport function clearAll() { m.clear(); }\n`;

async function call(
  root: string,
  input: Record<string, unknown> = {},
): Promise<{ text: string; data: IRegistryLifecycleReport }> {
  const inspection = await inspectSharkcraft({ cwd: root });
  const ctx: IToolContext = { inspection, cwd: root };
  const res = await tool!.handler(input, ctx);
  return { text: res.text ?? '', data: res.data as IRegistryLifecycleReport };
}

describe('get_registry_lifecycle_report', () => {
  test('it is registered under its wire name', () => {
    expect(tool).toBeDefined();
  });

  test('offset continues a capped scan: data.nextOffset, and the Next hint names --offset <n>', async () => {
    // Sorted candidates: sharkcraft/sharkcraft.config.ts, src/a.ts, src/b.ts, src/c.ts.
    const root = workspace({}, { 'src/a.ts': pair('A'), 'src/b.ts': pair('B'), 'src/c.ts': pair('C') });
    const page = await call(root, { limit: 1, offset: 1 });
    expect(page.data.offset).toBe(1);
    expect(page.data.nextOffset).toBe(2);
    expect(page.data.verdict).toBe('not-verified');
    expect(page.text).toContain('--offset 2');

    const rest = await call(root, { offset: 2 });
    expect(rest.data.nextOffset).toBeUndefined();
    expect(rest.data.matchedPairs.map((p) => p.registerName).sort()).toEqual(['registerB', 'registerC']);
  });

  test('registryLifecycle.skipDirsAdd from a real config reaches the scan', async () => {
    const root = workspace(
      { registryLifecycle: { skipDirsAdd: ['myexclude'] } },
      { 'src/ok.ts': pair('Ok'), 'myexclude/x.ts': miss('X') },
    );
    const r = await call(root);
    expect(r.data.skipDirs).toContain('myexclude');
    expect(r.data.missingRemovers).toEqual([]);
    expect(r.data.verdict).toBe('pass');
  });

  test('an EXISTING config that fails to load is never a pass — the shortfall names the unapplied skip set', async () => {
    const root = workspace({ bogusKey: 1 }, { 'src/ok.ts': pair('Ok') });
    const r = await call(root);
    expect(r.data.configCoverage).toMatchObject({ unit: 'config files', expected: 1, examined: 0 });
    expect(r.data.verdict).toBe('not-verified');
    expect(r.data.verdictReason).toContain('skipDirs');
    expect(r.data.warnings.join('\n')).toContain('failed to load');
    expect(r.text).toContain('not-verified');
  });
});
