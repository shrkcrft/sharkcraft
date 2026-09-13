/**
 * r77 — MCP `get_changed_boundary_report` carries the settled unit states the
 * changed-scope CLI run prints (round 13 review).
 *
 * The tool copied verdict / exitCode / shortfalls / runCoverage from THE
 * boundary orchestrator but dropped `accepted`, `intendedEmpty`, `wentLive`,
 * `failingUnits` and `deadUnits` — so over a marked planned unit it returned a
 * bare `pass` while `shrk check boundaries --files …` printed the acceptance
 * under its ✓, and over a marker that went live it returned `pass` with no
 * `wentLive` while the CLI withheld its ✓.
 *
 * Every call goes THROUGH `validateToolInput` first (the dual-schema gotcha),
 * over real temp workspaces, the real inspector, and the CLI from source.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { validateToolInput } from '../server/tool-input-validators.ts';
import { getChangedBoundaryReportTool } from '../tools/r28-changed-boundary.tool.ts';

const SLOW = 60_000;
const CLI_MAIN = join(resolve(import.meta.dir, '../../../..'), 'packages', 'cli', 'src', 'main.ts');
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const MARKED = `export default [{ id: 'layer.no-imports-up', title: 'No imports up', from: ['packages/app/**'],
  forbiddenImports: ['@scope/kernel-*', { pattern: '@scope/plugin-react', expectEmpty: true, reason: 'ADR-7: planned binding' }, { pattern: '@scope/kernel', expectEmpty: true }] }];\n`;

function fx(extra: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r77-mcp-changed-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0', private: true }),
    'packages/app/package.json': JSON.stringify({ name: '@scope/app', version: '0.0.0' }),
    'packages/app/src/x.ts': "import { u } from '@scope/util';\nexport const x = u;\n",
    'packages/kernel-a/package.json': JSON.stringify({ name: '@scope/kernel-a', version: '0.0.0' }),
    'packages/kernel-a/src/index.ts': 'export const k = 1;\n',
    'packages/util/package.json': JSON.stringify({ name: '@scope/util', version: '0.0.0' }),
    'packages/util/src/index.ts': 'export const u = 1;\n',
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx', boundaryFiles: ['boundaries.ts'] };\n",
    'sharkcraft/boundaries.ts': MARKED,
    ...extra,
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

interface ITypescriptBlock {
  readonly verdict: string;
  readonly exitCode: number;
  readonly accepted?: readonly string[];
  readonly intendedEmpty?: readonly { readonly selector: string }[];
  readonly wentLive?: readonly { readonly selector: string }[];
  readonly failingUnits?: readonly unknown[];
  readonly deadUnits?: readonly unknown[];
}

async function changedReport(root: string): Promise<ITypescriptBlock> {
  const input = { files: ['packages/app/src/x.ts'] };
  const v = validateToolInput('get_changed_boundary_report', input);
  expect(v.ok).toBe(true);
  const inspection = await inspectSharkcraft({ cwd: root });
  const res = await getChangedBoundaryReportTool.handler(v.ok ? (v.data as Record<string, unknown>) : input, {
    inspection,
    cwd: root,
  } as never);
  return (res.data as { typescript: ITypescriptBlock }).typescript;
}

function cliJson(root: string): { readonly exitCode: number; readonly accepted: readonly string[]; readonly wentLive: readonly unknown[] } {
  const r = spawnSync('bun', [CLI_MAIN, '--no-hints', '--cwd', root, 'check', 'boundaries', '--files', 'packages/app/src/x.ts', '--json'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return JSON.parse(r.stdout ?? '') as { exitCode: number; accepted: readonly string[]; wentLive: readonly unknown[] };
}

describe('get_changed_boundary_report — the settled unit states, as the CLI changed-scope run', () => {
  test(
    'a planned unit: the acceptance and the intended-empty units ride on the MCP answer, equal to the CLI',
    async () => {
      const root = fx();
      const ts = await changedReport(root);
      expect(ts.exitCode).toBe(0);
      expect((ts.accepted ?? []).join('\n')).toContain('accepted by expectEmpty');
      expect((ts.intendedEmpty ?? []).map((u) => u.selector).sort()).toEqual(['@scope/kernel', '@scope/plugin-react']);
      expect(ts.wentLive).toEqual([]);
      expect(ts.failingUnits).toEqual([]);
      expect(Array.isArray(ts.deadUnits)).toBe(true);
      const cli = cliJson(root);
      expect({ exit: ts.exitCode, accepted: ts.accepted }).toEqual({ exit: cli.exitCode, accepted: cli.accepted });
    },
    SLOW,
  );

  test(
    'a marker that went live: `wentLive` names it, as the CLI lists it',
    async () => {
      const root = fx({ 'packages/plugin-react/package.json': JSON.stringify({ name: '@scope/plugin-react', version: '0.0.0' }) });
      const ts = await changedReport(root);
      expect((ts.wentLive ?? []).map((u) => u.selector)).toContain('@scope/plugin-react');
      expect(cliJson(root).wentLive.length).toBe((ts.wentLive ?? []).length);
    },
    SLOW,
  );
});
