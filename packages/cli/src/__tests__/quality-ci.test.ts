import { describe, expect, test } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');

function shrk(args: readonly string[], cwd: string): {
  status: number;
  stdout: string;
  stderr: string;
} {
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
  const root = mkdtempSync(join(tmpdir(), 'shrk-quality-'));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  mkdirSync(join(root, 'sharkcraft', 'node_modules', '@shrkcrft'), { recursive: true });
  const symlinks: Array<[string, string]> = [
    ['config', 'packages/config'],
    ['knowledge', 'packages/knowledge'],
    ['templates', 'packages/templates'],
  ];
  for (const [name, relTarget] of symlinks) {
    const linkPath = join(root, 'sharkcraft', 'node_modules', '@shrkcrft', name);
    spawnSync('ln', ['-s', join(REPO_ROOT, relTarget), linkPath]);
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'q', version: '0.0.0' }));
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default { projectName: 'q', knowledgeFiles: [], ruleFiles: [], pathFiles: [], templateFiles: [], docsFiles: [] };\n`,
  );
  return root;
}

describe('shrk quality', () => {
  test('json output has overall/score/blockers/warnings + gates list', () => {
    const root = makeFixture();
    const r = shrk(['--cwd', root, 'quality', '--json'], root);
    // Quality is allowed to exit non-zero — the structural assertions are what we care about.
    const out = JSON.parse(r.stdout) as {
      overall: string;
      score: number;
      blockers: number;
      warnings: number;
      gates: { id: string; passed: boolean; blocking: boolean }[];
    };
    expect(['pass', 'warn', 'fail'].includes(out.overall)).toBe(true);
    expect(typeof out.score).toBe('number');
    expect(out.gates.some((g) => g.id === 'doctor')).toBe(true);
    expect(out.gates.some((g) => g.id === 'boundaries')).toBe(true);
    expect(out.gates.some((g) => g.id === 'coverage')).toBe(true);
  });

  test('--strict promotes warnings to blockers', () => {
    const root = makeFixture();
    const r = shrk(['--cwd', root, 'quality', '--strict', '--json'], root);
    const out = JSON.parse(r.stdout) as { gates: { blocking: boolean; passed: boolean }[] };
    // After --strict, every gate is blocking.
    for (const g of out.gates) {
      if (!g.passed) expect(g.blocking).toBe(true);
    }
  });
});

describe('shrk ci scaffold github-actions', () => {
  test('dry-run prints YAML with chosen step', () => {
    const root = makeFixture();
    const r = shrk(
      ['--cwd', root, 'ci', 'scaffold', 'github-actions', '--with-quality', '--with-boundaries'],
      root,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('SharkCraft quality');
    expect(r.stdout).toContain('shrk check boundaries');
  });

  test('--write materializes the file at --output', () => {
    const root = makeFixture();
    const out = '.github/workflows/sharkcraft.yml';
    const r = shrk(
      ['--cwd', root, 'ci', 'scaffold', 'github-actions', '--with-quality', '--output', out, '--write'],
      root,
    );
    expect(r.status).toBe(0);
    const full = join(root, out);
    expect(existsSync(full)).toBe(true);
    const body = readFileSync(full, 'utf8');
    expect(body).toContain('shrk quality');
  });

  test('refuses to overwrite an existing file without --force', () => {
    const root = makeFixture();
    const out = '.github/workflows/sharkcraft.yml';
    shrk(['--cwd', root, 'ci', 'scaffold', 'github-actions', '--with-quality', '--output', out, '--write'], root);
    const r = shrk(
      ['--cwd', root, 'ci', 'scaffold', 'github-actions', '--with-quality', '--output', out, '--write'],
      root,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Refusing');
  });
});
