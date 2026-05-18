import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
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
  const root = mkdtempSync(join(tmpdir(), 'shrk-ci-html-'));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  mkdirSync(join(root, 'sharkcraft', 'node_modules', '@shrkcrft'), { recursive: true });
  for (const [n, t] of [
    ['config', 'packages/config'],
    ['knowledge', 'packages/knowledge'],
    ['templates', 'packages/templates'],
  ] as const) {
    spawnSync('ln', ['-s', join(REPO_ROOT, t), join(root, 'sharkcraft', 'node_modules', '@shrkcrft', n)]);
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'h', version: '0.0.0' }));
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default { projectName: 'h', knowledgeFiles: [], ruleFiles: [], pathFiles: [], templateFiles: [], docsFiles: [] };\n`,
  );
  return root;
}

describe('shrk ci scaffold new flags', () => {
  test('--with-drift-gate adds --require-drift-clean to the quality step', () => {
    const root = makeFixture();
    const r = shrk(
      ['ci', 'scaffold', 'github-actions', '--with-quality', '--with-drift-gate'],
      root,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('require-drift-clean');
  });

  test('--with-node-compat adds the compat:node step', () => {
    const root = makeFixture();
    const r = shrk(
      ['ci', 'scaffold', 'github-actions', '--with-node-compat'],
      root,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('compat:node');
  });

  test('--with-safety-audit adds the safety audit step', () => {
    const root = makeFixture();
    const r = shrk(
      ['ci', 'scaffold', 'github-actions', '--with-safety-audit'],
      root,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('shrk safety audit');
  });

  test('--with-command-doctor adds the commands doctor step', () => {
    const root = makeFixture();
    const r = shrk(
      ['ci', 'scaffold', 'github-actions', '--with-command-doctor'],
      root,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('shrk commands doctor');
  });

  test('--with-pack-tests --pack-paths inserts a pack-test step per path', () => {
    const root = makeFixture();
    const r = shrk(
      [
        'ci',
        'scaffold',
        'github-actions',
        '--with-pack-tests',
        '--pack-paths',
        './packs/a,./packs/b',
      ],
      root,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('shrk packs test ./packs/a --load');
    expect(r.stdout).toContain('shrk packs test ./packs/b --load');
  });
});

describe('shrk dev report --html / dev open --html', () => {
  test('dev report --html writes final-report.html', () => {
    const root = makeFixture();
    expect(shrk(['--cwd', root, 'dev', 'start', 'cf-test'], root).status).toBe(0);
    const sessionsDir = join(root, '.sharkcraft', 'sessions');
    const id = readdirSync(sessionsDir).sort()[0]!;
    const r = shrk(['--cwd', root, 'dev', 'report', id, '--html', '--json'], root);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { htmlPath: string };
    expect(out.htmlPath).toContain('final-report.html');
    const body = readFileSync(out.htmlPath, 'utf8');
    expect(body).toContain('<!doctype html>');
    expect(body).toContain('cf-test');
  });

  test('dev open --html writes final-report.html without state changes', () => {
    const root = makeFixture();
    shrk(['--cwd', root, 'dev', 'start', 'open-html-test'], root);
    const sessionsDir = join(root, '.sharkcraft', 'sessions');
    const id = readdirSync(sessionsDir).sort()[0]!;
    const r = shrk(['--cwd', root, 'dev', 'open', id, '--html', '--json'], root);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { htmlPath: string };
    expect(existsSync(out.htmlPath)).toBe(true);
    // Open should not have marked the session completed.
    const state = JSON.parse(readFileSync(join(sessionsDir, id, 'session.json'), 'utf8')) as {
      phase: string;
    };
    expect(state.phase).toBe('started');
  });
});
