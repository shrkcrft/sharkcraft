import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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
  const root = mkdtempSync(join(tmpdir(), 'shrk-drift-safety-'));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  mkdirSync(join(root, 'sharkcraft', 'node_modules', '@shrkcrft'), { recursive: true });
  for (const [n, t] of [
    ['config', 'packages/config'],
    ['knowledge', 'packages/knowledge'],
    ['templates', 'packages/templates'],
  ] as const) {
    spawnSync('ln', ['-s', join(REPO_ROOT, t), join(root, 'sharkcraft', 'node_modules', '@shrkcrft', n)]);
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'q', version: '0.0.0' }));
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default { projectName: 'q', knowledgeFiles: [], ruleFiles: [], pathFiles: [], templateFiles: [], docsFiles: [] };\n`,
  );
  return root;
}

describe('shrk quality drift gate', () => {
  test('json output includes a drift gate + drift summary', () => {
    const root = makeFixture();
    const r = shrk(['--cwd', root, 'quality', '--json'], root);
    const out = JSON.parse(r.stdout) as {
      gates: { id: string; passed: boolean; blocking: boolean }[];
      drift?: { counts: { error: number; warning: number; info: number } };
    };
    expect(out.gates.some((g) => g.id === 'drift')).toBe(true);
    expect(out.drift).toBeDefined();
  });

  test('--require-drift-clean makes the drift gate blocking', () => {
    const root = makeFixture();
    const r = shrk(['--cwd', root, 'quality', '--require-drift-clean', '--json'], root);
    const out = JSON.parse(r.stdout) as { gates: { id: string; blocking: boolean }[] };
    const drift = out.gates.find((g) => g.id === 'drift')!;
    expect(drift.blocking).toBe(true);
  });
});

describe('shrk safety audit', () => {
  test('json output exposes commands grouped by safety level', () => {
    const root = makeFixture();
    const r = shrk(['--cwd', root, 'safety', 'audit', '--json'], root);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as {
      mcp: { anyWritable: boolean; tools: { name: string }[] };
      commands: { writesSource: unknown[] };
      recommendations: string[];
    };
    expect(out.mcp.anyWritable).toBe(false);
    expect(out.mcp.tools.length).toBeGreaterThan(0);
    expect(Array.isArray(out.commands.writesSource)).toBe(true);
  });
});

describe('shrk commands doctor', () => {
  test('json output reports passed=true with no errors', () => {
    const root = makeFixture();
    const r = shrk(['--cwd', root, 'commands', 'doctor', '--json'], root);
    const out = JSON.parse(r.stdout) as {
      passed: boolean;
      summary: { errors: number };
    };
    expect(out.summary.errors).toBe(0);
    expect(out.passed).toBe(true);
  });
});
