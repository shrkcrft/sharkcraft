import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
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
  return {
    status: res.status ?? -1,
    stdout: res.stdout?.toString() ?? '',
    stderr: res.stderr?.toString() ?? '',
  };
}

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-adopt-status-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'h', version: '0.0.0', scripts: { build: 'tsc', test: 'bun test' } }));
  writeFileSync(join(root, 'src/index.ts'), 'export function hello() { return "world"; }\n');
  return root;
}

describe('shrk onboard adopt status / regenerate / check', () => {
  test('status reports missing state cleanly', () => {
    const root = makeFixture();
    const r = shrk(['--cwd', root, 'onboard', 'adopt', 'status', '--json'], root);
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout) as { stateExists: boolean; nextCommand: string };
    expect(data.stateExists).toBe(false);
    expect(data.nextCommand).toContain('--write-drafts');
  });

  test('write-patch → status returns fresh', () => {
    const root = makeFixture();
    expect(shrk(['--cwd', root, 'onboard', '--write-drafts'], root).status).toBe(0);
    expect(shrk(['--cwd', root, 'onboard', 'adopt', '--write-patch', '--diff-format', 'unified'], root).status).toBe(0);
    const r = shrk(['--cwd', root, 'onboard', 'adopt', 'status', '--json'], root);
    const data = JSON.parse(r.stdout) as { freshness: { status: string }; patchExists: boolean };
    expect(data.patchExists).toBe(true);
    expect(data.freshness.status).toBe('fresh');
  });

  test('regenerate archives prior outputs under history/', () => {
    const root = makeFixture();
    shrk(['--cwd', root, 'onboard', '--write-drafts'], root);
    shrk(['--cwd', root, 'onboard', 'adopt', '--write-patch', '--diff-format', 'unified'], root);
    const r = shrk(['--cwd', root, 'onboard', 'adopt', 'regenerate', '--json'], root);
    expect(r.status).toBe(0);
    const history = join(root, 'sharkcraft/onboarding/adoption/history');
    expect(existsSync(history)).toBe(true);
    expect(readdirSync(history).length).toBeGreaterThan(0);
  });

  test('adopt check on fresh patch reports can-apply', () => {
    const root = makeFixture();
    shrk(['--cwd', root, 'onboard', '--write-drafts'], root);
    shrk(['--cwd', root, 'onboard', 'adopt', '--write-patch', '--diff-format', 'unified'], root);
    const r = shrk(['--cwd', root, 'onboard', 'adopt', 'check', '--json'], root);
    const data = JSON.parse(r.stdout) as { canApply: string };
    expect(data.canApply === 'can-apply' || data.canApply === 'unknown').toBe(true);
  });

  test('merge-preview --format markdown shows three-way verdicts', () => {
    const root = makeFixture();
    shrk(['--cwd', root, 'onboard', '--write-drafts'], root);
    shrk(['--cwd', root, 'onboard', 'adopt', '--write-patch', '--diff-format', 'unified'], root);
    const r = shrk(['--cwd', root, 'onboard', 'adopt', 'merge-preview', '--format', 'markdown'], root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Three-way verdicts per target');
  });

  test('report --format json embeds the runtime-report envelope (via report command)', () => {
    const root = makeFixture();
    shrk(['--cwd', root, 'onboard', '--write-drafts'], root);
    shrk(['--cwd', root, 'onboard', 'adopt', '--write-patch'], root);
    const r = shrk(['--cwd', root, 'report', 'adoption', '--format', 'json'], root);
    expect(r.status).toBe(0);
    const envelope = JSON.parse(r.stdout) as { schema: string; reportKind: string };
    expect(envelope.schema).toBe('sharkcraft.runtime-report/v1');
    expect(envelope.reportKind).toBe('adoption');
  });
});
