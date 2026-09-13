/**
 * r75 — `get_changed_boundary_report` over ZERO boundary rules carries the
 * verdict its siblings give (round 11 review MCP-5).
 *
 * A `hasRules` guard skipped THE boundary orchestrator and answered
 * `typescript: null` — no verdict at all — while MCP `check_boundaries` and
 * `shrk check boundaries --changed-only` both said not-verified (2). All three
 * go through `runBoundaryCheck` now.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '@shrkcrft/mcp-server';
import type { ParsedArgs } from '../command-registry.ts';
import { checkCommand } from '../commands/check.command.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tool(name: string): (typeof ALL_TOOLS)[number] {
  const t = ALL_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`MCP tool ${name} is not registered`);
  return t;
}

async function runJson(root: string, flags: Record<string, string | boolean>): Promise<{ code: number; json: Record<string, unknown> }> {
  const a: ParsedArgs = {
    positional: ['boundaries'],
    flags: new Map<string, string | boolean>([['cwd', root], ['json', true], ...Object.entries(flags)]),
    multiFlags: new Map(),
  };
  const orig = process.stdout.write.bind(process.stdout);
  let out = '';
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await checkCommand.run(a);
    return { code, json: JSON.parse(out) as Record<string, unknown> };
  } finally {
    process.stdout.write = orig;
  }
}

describe('zero boundary rules — one verdict across the three boundary surfaces', () => {
  test('MCP get_changed_boundary_report ≡ MCP check_boundaries ≡ CLI --changed-only: not-verified, 2', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-r75-norules-'));
    roots.push(root);
    for (const [rel, body] of Object.entries({
      'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
      'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
      'src/a.ts': 'export const a = 1;\n',
    })) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), body);
    }
    const inspection = await inspectSharkcraft({ cwd: root });
    const changed = (await tool('get_changed_boundary_report').handler({ files: ['src/a.ts'] }, { inspection, cwd: root }))
      .data as { typescript: { verdict: string; exitCode: number } | null };
    expect(changed.typescript).not.toBeNull();
    const check = (await tool('check_boundaries').handler({}, { inspection, cwd: root })).data as {
      verdict: string;
      exitCode: number;
    };
    const cli = await runJson(root, { 'changed-only': true });
    expect({
      changed: { verdict: changed.typescript?.verdict, exitCode: changed.typescript?.exitCode },
      check: { verdict: check.verdict, exitCode: check.exitCode },
      cli: { verdict: cli.json['verdict'], exitCode: cli.code },
    }).toEqual({
      changed: { verdict: 'not-verified', exitCode: 2 },
      check: { verdict: 'not-verified', exitCode: 2 },
      cli: { verdict: 'not-verified', exitCode: 2 },
    });
  }, 60_000);
});
