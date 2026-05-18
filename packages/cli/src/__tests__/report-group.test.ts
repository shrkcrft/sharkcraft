import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');

function shrk(args: readonly string[], cwd: string) {
  const res = spawnSync('bun', ['run', CLI_MAIN, ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return { status: res.status ?? -1, stdout: res.stdout?.toString() ?? '', stderr: res.stderr?.toString() ?? '' };
}

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-report-grp-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'h', version: '0.0.0', scripts: { build: 'tsc' } }));
  writeFileSync(join(root, 'src/index.ts'), 'export function hello() { return "world"; }\n');
  return root;
}

describe('shrk report group', () => {
  test('report quality --format json wraps in runtime-report/v1', () => {
    const root = makeFixture();
    const r = shrk(['--cwd', root, 'report', 'quality', '--format', 'json'], root);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout) as { schema: string; reportKind: string };
    expect(env.schema).toBe('sharkcraft.runtime-report/v1');
    expect(env.reportKind).toBe('quality');
  });

  test('report safety --format html includes the MCP read-only badge', () => {
    const root = makeFixture();
    const r = shrk(['--cwd', root, 'report', 'safety', '--format', 'html'], root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('<!doctype html>');
    expect(r.stdout).toContain('MCP read-only invariant');
  });

  test('report adoption --output writes a file', () => {
    const root = makeFixture();
    shrk(['--cwd', root, 'onboard', '--write-drafts'], root);
    shrk(['--cwd', root, 'onboard', 'adopt', '--write-patch'], root);
    const out = join(root, 'adopt.html');
    const r = shrk(['--cwd', root, 'report', 'adoption', '--format', 'html', '--output', out], root);
    expect(r.status).toBe(0);
    expect(existsSync(out)).toBe(true);
  });

  test('report coverage --format markdown returns Coverage header', () => {
    const root = makeFixture();
    const r = shrk(['--cwd', root, 'report', 'coverage', '--format', 'markdown'], root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('# Coverage');
  });
});
