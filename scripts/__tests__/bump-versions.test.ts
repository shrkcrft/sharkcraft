import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');

describe('bump-versions script', () => {
  test('dry-run reports a target version without modifying files', () => {
    const res = spawnSync(
      'bun',
      ['run', join(REPO_ROOT, 'scripts/bump-versions.ts'), '0.1.0-alpha.99', '--dry-run'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    expect(res.status).toBe(0);
    const out = res.stdout ?? '';
    expect(out).toContain('[DRY-RUN]');
    expect(out).toContain('0.1.0-alpha.99');
    expect(out).toContain('core');
    expect(out).toContain('cli');
    expect(out).toContain('mcp-server');
  });

  test('rejects invalid semver', () => {
    const res = spawnSync(
      'bun',
      ['run', join(REPO_ROOT, 'scripts/bump-versions.ts'), 'not-a-version', '--dry-run'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    expect(res.status).not.toBe(0);
  });

  test('rejects both --dry-run and --write together', () => {
    const res = spawnSync(
      'bun',
      [
        'run',
        join(REPO_ROOT, 'scripts/bump-versions.ts'),
        '0.1.0-alpha.99',
        '--dry-run',
        '--write',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    expect(res.status).not.toBe(0);
  });
});
