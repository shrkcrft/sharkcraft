import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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

function makeFixture(verificationCommands: string): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-apply-ver-'));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  mkdirSync(join(root, 'sharkcraft', 'node_modules', '@shrkcrft'), { recursive: true });
  for (const [name, relTarget] of [
    ['config', 'packages/config'],
    ['knowledge', 'packages/knowledge'],
    ['templates', 'packages/templates'],
  ] as const) {
    spawnSync('ln', [
      '-s',
      join(REPO_ROOT, relTarget),
      join(root, 'sharkcraft', 'node_modules', '@shrkcrft', name),
    ]);
  }
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'apply-ver-fixture', version: '0.0.0' }),
  );
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    [
      `export default {`,
      `  projectName: 'apply-ver-fixture',`,
      `  knowledgeFiles: [],`,
      `  ruleFiles: [],`,
      `  pathFiles: [],`,
      `  templateFiles: ['templates.ts'],`,
      `  docsFiles: [],`,
      `  verificationCommands: ${verificationCommands},`,
      `};`,
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'sharkcraft', 'templates.ts'),
    `export const tsService = {
  id: 'typescript.service',
  name: 'Service',
  description: 'A service.',
  tags: ['ts'],
  scope: ['ts'],
  appliesWhen: ['generate-service'],
  variables: [
    { name: 'name', required: true },
    { name: 'className', required: true },
  ],
  targetPath: ({ name }) => 'src/services/' + name + '.service.ts',
  content: ({ className }) => 'export class ' + className + ' {}\\n',
};
export default [tsService];
`,
  );
  return root;
}

function writePlan(root: string): string {
  const planPath = join(root, 'plan.json');
  const plan = {
    schema: 'sharkcraft.plan/v1',
    templateId: 'typescript.service',
    name: 'user',
    variables: { name: 'user', className: 'UserService' },
    projectRoot: root,
    createdAt: '2026-05-01T00:00:00Z',
    expectedChanges: [
      {
        type: 'create',
        relativePath: 'src/services/user.service.ts',
        sizeBytes: 28,
      },
    ],
  };
  writeFileSync(planPath, JSON.stringify(plan));
  return planPath;
}

describe('shrk apply --validate --verification <id>', () => {
  test('runs the configured verification command by id', () => {
    const root = makeFixture(
      `[ { id: 'echo-ok', command: 'echo OK_VERIFY', trusted: true } ]`,
    );
    const planPath = writePlan(root);
    const r = shrk(
      ['apply', planPath, '--validate', '--verification', 'echo-ok'],
      root,
    );
    expect(r.status).toBe(0);
    // The wrapper prints "  → running: echo-ok: echo OK_VERIFY"
    expect(r.stdout).toContain('echo-ok');
    // The echoed token shows the command actually ran.
    expect(r.stdout).toContain('OK_VERIFY');
  });

  test('--all-verifications runs every configured command', () => {
    const root = makeFixture(
      `[
        { id: 'one', command: 'echo ONE_VERIFY', trusted: true },
        { id: 'two', command: 'echo TWO_VERIFY', trusted: true },
      ]`,
    );
    const planPath = writePlan(root);
    const r = shrk(
      ['apply', planPath, '--validate', '--all-verifications'],
      root,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ONE_VERIFY');
    expect(r.stdout).toContain('TWO_VERIFY');
  });

  test('unknown --verification id fails the run with a clear error', () => {
    const root = makeFixture(
      `[ { id: 'echo-ok', command: 'echo OK_VERIFY', trusted: true } ]`,
    );
    const planPath = writePlan(root);
    const r = shrk(
      ['apply', planPath, '--validate', '--verification', 'no-such-id'],
      root,
    );
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/unknown verification id|no-such-id/i);
  });
});
