import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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

describe('shrk scaffolds + infer templates', () => {
  test('scaffolds list returns empty array in a vanilla project', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-scaffolds-empty-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
    const r = shrk(['--cwd', root, 'scaffolds', 'list', '--json'], root);
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout) as { patterns: unknown[] };
    expect(Array.isArray(data.patterns)).toBe(true);
    expect(data.patterns.length).toBe(0);
  });

  test('scaffolds doctor exits 0 when no patterns present', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-scaffolds-doctor-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
    const r = shrk(['--cwd', root, 'scaffolds', 'doctor', '--json'], root);
    expect(r.status).toBe(0);
  });

  test('infer templates --kind service produces JSON candidates', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-infer-tpl-'));
    mkdirSync(join(root, 'src/services'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
    writeFileSync(
      join(root, 'src/services/user.service.ts'),
      'export class UserService { greet() { return "hi"; } }\n',
    );
    const r = shrk(['--cwd', root, 'infer', 'templates', '--ast', '--kind', 'service', '--json'], root);
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout) as { candidates: Array<{ sample: string; scaffold?: unknown }> };
    expect(data.candidates.length).toBeGreaterThan(0);
    expect(data.candidates[0]?.sample).toContain('user.service.ts');
  });
});
