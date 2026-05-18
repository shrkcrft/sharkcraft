import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
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
  const root = mkdtempSync(join(tmpdir(), 'shrk-graph-'));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  mkdirSync(join(root, 'sharkcraft', 'node_modules', '@shrkcrft'), { recursive: true });
  for (const [n, t] of [
    ['config', 'packages/config'],
    ['knowledge', 'packages/knowledge'],
    ['templates', 'packages/templates'],
  ] as const) {
    spawnSync('ln', ['-s', join(REPO_ROOT, t), join(root, 'sharkcraft', 'node_modules', '@shrkcrft', n)]);
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'g', version: '0.0.0' }));
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default { projectName: 'g', knowledgeFiles: [], ruleFiles: [], pathFiles: [], templateFiles: ['t.ts'], docsFiles: [] };\n`,
  );
  writeFileSync(
    join(root, 'sharkcraft', 't.ts'),
    `export default [{ id: 'demo.template', name: 'Demo', description: 'demo', tags: [], scope: [], appliesWhen: ['create'], variables: [{ name: 'name', required: true }], targetPath: ({ name }) => 'src/'+name+'.ts', content: () => 'x\\n' }];\n`,
  );
  return root;
}

describe('shrk graph dot/mermaid output', () => {
  test('--format dot returns a digraph', () => {
    const root = makeFixture();
    const r = shrk(['--cwd', root, 'graph', '--format', 'dot'], root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('digraph SharkCraftKnowledge');
  });

  test('--format mermaid returns a Mermaid graph', () => {
    const root = makeFixture();
    const r = shrk(['--cwd', root, 'graph', '--format', 'mermaid'], root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('graph LR');
  });

  test('export --format dot --output writes file', () => {
    const root = makeFixture();
    const r = shrk(
      ['--cwd', root, 'graph', 'export', '--format', 'dot', '--output', 'graph.dot'],
      root,
    );
    expect(r.status).toBe(0);
    const full = join(root, 'graph.dot');
    expect(existsSync(full)).toBe(true);
    expect(readFileSync(full, 'utf8')).toContain('digraph SharkCraftKnowledge');
  });
});
