import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const FIXTURE = join(REPO_ROOT, 'examples/unconfigured-bun-service');

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

describe('shrk onboard CLI', () => {
  test('dry-run produces the expected sections', () => {
    const r = shrk(['--cwd', FIXTURE, 'onboard', '--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('SharkCraft onboarding');
    expect(r.stdout).toMatch(/mode\s+dry-run/);
    expect(r.stdout).toContain('Recommended presets:');
    expect(r.stdout).toContain('Path conventions inferred:');
    expect(r.stdout).toContain('Verification commands inferred:');
    expect(r.stdout).toContain('Template candidates:');
    expect(r.stdout).toContain('Rules inferred:');
    expect(r.stdout).toContain('Pipelines inferred:');
    expect(r.stdout).toContain('Next:');
    expect(r.stdout).toContain('Dry-run only.');
  });

  test('--json emits structured plan + nextCommand', () => {
    const r = shrk(['--cwd', FIXTURE, 'onboard', '--json']);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.mode).toBe('dry-run');
    expect(out.plan.inferredVerificationCommands.length).toBeGreaterThan(0);
    expect(out.plan.readiness.current).toMatch(
      /poor|partial|good|excellent/,
    );
  });

  test('--write-drafts writes 6 files under sharkcraft/onboarding/', () => {
    const r = shrk(['--cwd', FIXTURE, 'onboard', '--write-drafts']);
    expect(r.status).toBe(0);
    const dir = join(FIXTURE, 'sharkcraft', 'onboarding');
    expect(existsSync(join(dir, 'onboarding-report.md'))).toBe(true);
    expect(existsSync(join(dir, 'inferred-rules.draft.ts'))).toBe(true);
    expect(existsSync(join(dir, 'inferred-paths.draft.ts'))).toBe(true);
    expect(existsSync(join(dir, 'inferred-templates.draft.ts'))).toBe(true);
    expect(existsSync(join(dir, 'inferred-boundaries.draft.ts'))).toBe(true);
    expect(existsSync(join(dir, 'inferred-pipelines.draft.ts'))).toBe(true);
    // Critically: SharkCraft must NOT create the final rules/paths/templates files.
    expect(existsSync(join(FIXTURE, 'sharkcraft', 'rules.ts'))).toBe(false);
    expect(existsSync(join(FIXTURE, 'sharkcraft', 'paths.ts'))).toBe(false);
    expect(existsSync(join(FIXTURE, 'sharkcraft', 'templates.ts'))).toBe(false);
  });
});
