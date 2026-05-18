import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');

function shrk(args: readonly string[]): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync('bun', ['run', CLI_MAIN, ...args], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout?.toString() ?? '',
    stderr: res.stderr?.toString() ?? '',
  };
}

describe('shrk review scaffold github-action', () => {
  test('prints a valid GitHub Actions workflow YAML', () => {
    const r = shrk(['review', 'scaffold', 'github-action']);
    expect(r.status).toBe(0);
    // Must look like a real workflow.
    expect(r.stdout).toContain('name: SharkCraft review packet');
    expect(r.stdout).toContain('on:');
    expect(r.stdout).toContain('pull_request:');
    expect(r.stdout).toContain('jobs:');
    expect(r.stdout).toContain('actions/checkout@v4');
    expect(r.stdout).toContain('oven-sh/setup-bun');
    expect(r.stdout).toContain('shrk review --since origin/main --json');
    expect(r.stdout).toContain('actions/upload-artifact@v4');
    expect(r.stdout).toContain('sharkcraft-review-packet');
  });

  test('unknown scaffold target returns non-zero with a helpful message', () => {
    const r = shrk(['review', 'scaffold', 'nope']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Unknown scaffold');
  });

  test('--with-boundaries adds the boundary step + artifact', () => {
    const r = shrk(['review', 'scaffold', 'github-action', '--with-boundaries']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('shrk check boundaries --json');
    expect(r.stdout).toContain('name: sharkcraft-boundaries');
  });

  test('--with-coverage and --with-drift add their respective steps', () => {
    const r = shrk([
      'review',
      'scaffold',
      'github-action',
      '--with-coverage',
      '--with-drift',
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('shrk coverage --json');
    expect(r.stdout).toContain('shrk drift --json');
    expect(r.stdout).toContain('name: sharkcraft-coverage');
    expect(r.stdout).toContain('name: sharkcraft-drift');
  });

  test('--comment-placeholder adds the placeholder step', () => {
    const r = shrk([
      'review',
      'scaffold',
      'github-action',
      '--comment-placeholder',
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PR comment placeholder');
  });

  test('--artifact-only suppresses the comment placeholder', () => {
    const r = shrk([
      'review',
      'scaffold',
      'github-action',
      '--comment-placeholder',
      '--artifact-only',
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('PR comment placeholder');
  });
});
