/**
 * Round 11 (integration lane, item 4) — MCP can no longer read "pass" over a
 * partial gate.
 *
 * `IQualityReport.overall` had no not-verified state, so `get_quality_report`
 * (and the dashboard summary built on it) said `pass` while a gate examined
 * only part of its scope. The report now derives `overall` through core's
 * `coverageShortfall` over one classification of its gates, and both MCP tools
 * return `not-verified`. MCP stays read-only: nothing is written.
 *
 * The partial gate is REAL: a warning boundary rule whose scope glob matches
 * no file, through the real inspector and the real tools.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '../tools/index.ts';

const TIMEOUT_MS = 60_000;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-mcp-quality-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const PARTIAL = {
  'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx', boundaryFiles: ['boundaries.ts'] };\n",
  'sharkcraft/boundaries.ts':
    "export default [{ id: 'old.dead', title: 'Old', severity: 'warning', from: ['packages/old/**'], forbiddenImports: ['@scope/ui'] }];\n",
  'src/a.ts': 'export const A = 1;\n',
};

function tool(name: string): (typeof ALL_TOOLS)[number] {
  const t = ALL_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no MCP tool ${name}`);
  return t;
}

describe('MCP quality surfaces over a partial gate', () => {
  test('get_quality_report says not-verified (never pass), names the gate, and writes nothing', async () => {
    const root = workspace(PARTIAL);
    const before = readdirSync(root).sort();
    const inspection = await inspectSharkcraft({ cwd: root });
    const r = await tool('get_quality_report').handler({}, { inspection, cwd: root });
    const data = r.data as {
      overall: string;
      coverage: { unexamined?: string[] };
      shortfalls: string[];
      gates: { id: string; passed: boolean; data?: Record<string, unknown> }[];
    };
    const boundaries = data.gates.find((g) => g.id === 'boundaries');
    expect({ passed: boundaries?.passed, partial: boundaries?.data?.['partial'] }).toEqual({ passed: true, partial: true });
    expect(data.overall).toBe('not-verified');
    expect(data.coverage.unexamined).toContain('boundaries');
    expect(data.shortfalls.join('\n')).toContain('boundaries');
    expect(readdirSync(root).sort()).toEqual(before);
  }, TIMEOUT_MS);

  test('get_dashboard_summary carries the same not-verified overall', async () => {
    const root = workspace(PARTIAL);
    const inspection = await inspectSharkcraft({ cwd: root });
    const r = await tool('get_dashboard_summary').handler({}, { inspection, cwd: root });
    const data = r.data as { quality: { overall: string } | null };
    expect(data.quality?.overall).toBe('not-verified');
  }, TIMEOUT_MS);

  test('without a partial gate the report is never not-verified', async () => {
    const root = workspace({
      'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
      'src/a.ts': 'export const A = 1;\n',
    });
    const inspection = await inspectSharkcraft({ cwd: root });
    const data = (await tool('get_quality_report').handler({}, { inspection, cwd: root })).data as {
      overall: string;
      shortfalls: string[];
    };
    expect(['pass', 'warn']).toContain(data.overall);
    expect(data.shortfalls).toEqual([]);
  }, TIMEOUT_MS);
});
