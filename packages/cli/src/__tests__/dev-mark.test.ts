import { describe, expect, test } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
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
  const root = mkdtempSync(join(tmpdir(), 'shrk-dev-mark-'));
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
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.0.0' }),
  );
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default { projectName: 'fixture', knowledgeFiles: [], ruleFiles: [], pathFiles: [], templateFiles: ['templates.ts'], docsFiles: [] };\n`,
  );
  writeFileSync(
    join(root, 'sharkcraft', 'templates.ts'),
    `export const tsService = { id: 'typescript.service', name: 'Service', description: 'Create a service.', tags: ['ts'], scope: ['ts'], appliesWhen: ['generate-service','create-service'], variables: [{ name: 'name', required: true }, { name: 'className', required: true }], targetPath: ({ name }) => 'src/services/' + name + '.service.ts', content: ({ className }) => 'export class ' + className + ' {}\\n' };\nexport default [tsService];\n`,
  );
  return root;
}

describe('shrk dev mark-applied / mark-validated', () => {
  test('mark-applied promotes the plan entry to applied and records appliedPlans', () => {
    const root = makeFixture();
    const r1 = shrk(['--cwd', root, 'dev', 'start', 'create user profile service'], root);
    expect(r1.status).toBe(0);
    const sessionsDir = join(root, '.sharkcraft', 'sessions');
    const id = readdirSync(sessionsDir).sort()[0]!;
    expect(
      shrk(
        ['--cwd', root, 'dev', 'plan', id, '--template', 'typescript.service', '--name', 'user-profile', '--var', 'className=UserProfileService'],
        root,
      ).status,
    ).toBe(0);
    const r = shrk(['--cwd', root, 'dev', 'mark-applied', id, 'user-profile.json', '--note', 'manual', '--json'], root);
    expect(r.status).toBe(0);
    const state = JSON.parse(readFileSync(join(sessionsDir, id, 'session.json'), 'utf8')) as {
      appliedPlans: { file: string; note?: string }[];
      plans: { name: string; status: string }[];
      phase: string;
    };
    expect(state.appliedPlans.some((a) => a.file === 'user-profile.json')).toBe(true);
    const entry = state.plans.find((p) => p.name === 'user-profile');
    expect(entry?.status).toBe('applied');
  });

  test('mark-validated records a validation entry and sets phase=validated', () => {
    const root = makeFixture();
    shrk(['--cwd', root, 'dev', 'start', 'create user profile service'], root);
    const sessionsDir = join(root, '.sharkcraft', 'sessions');
    const id = readdirSync(sessionsDir).sort()[0]!;
    shrk(['--cwd', root, 'dev', 'plan', id, '--template', 'typescript.service', '--name', 'user-profile', '--var', 'className=UserProfileService'], root);
    const r = shrk(['--cwd', root, 'dev', 'mark-validated', id, '--status', 'passed', '--json'], root);
    expect(r.status).toBe(0);
    const state = JSON.parse(readFileSync(join(sessionsDir, id, 'session.json'), 'utf8')) as {
      phase: string;
      validations: { passed: boolean }[];
    };
    expect(state.validations.length).toBe(1);
    expect(state.validations[0]!.passed).toBe(true);
    expect(state.phase).toBe('validated');
  });

  test('mark-validated --status failed produces validation_failed phase', () => {
    const root = makeFixture();
    shrk(['--cwd', root, 'dev', 'start', 'create user profile service'], root);
    const sessionsDir = join(root, '.sharkcraft', 'sessions');
    const id = readdirSync(sessionsDir).sort()[0]!;
    const r = shrk(['--cwd', root, 'dev', 'mark-validated', id, '--status', 'failed', '--json'], root);
    expect(r.status).toBe(0);
    const state = JSON.parse(readFileSync(join(sessionsDir, id, 'session.json'), 'utf8')) as {
      phase: string;
    };
    expect(state.phase).toBe('validation_failed');
  });
});

describe('shrk dev list / archive', () => {
  test('list returns detailed records', () => {
    const root = makeFixture();
    shrk(['--cwd', root, 'dev', 'start', 'one'], root);
    shrk(['--cwd', root, 'dev', 'start', 'two'], root);
    const r = shrk(['--cwd', root, 'dev', 'list', '--json'], root);
    expect(r.status).toBe(0);
    const items = JSON.parse(r.stdout) as { id: string; phase: string | null }[];
    expect(items.length).toBe(2);
    expect(items[0]!.phase).toBeDefined();
  });

  test('archive moves session to sessions-archive/', () => {
    const root = makeFixture();
    shrk(['--cwd', root, 'dev', 'start', 'archive-me'], root);
    const sessionsDir = join(root, '.sharkcraft', 'sessions');
    const id = readdirSync(sessionsDir).sort()[0]!;
    const r = shrk(['--cwd', root, 'dev', 'archive', id, '--json'], root);
    expect(r.status).toBe(0);
    expect(existsSync(join(sessionsDir, id))).toBe(false);
    expect(existsSync(join(root, '.sharkcraft', 'sessions-archive', id))).toBe(true);
  });
});

describe('shrk dev commands / open / plans / reports', () => {
  test('dev commands prints copy-pasteable command list', () => {
    const root = makeFixture();
    shrk(['--cwd', root, 'dev', 'start', 'cmd-test'], root);
    const sessionsDir = join(root, '.sharkcraft', 'sessions');
    const id = readdirSync(sessionsDir).sort()[0]!;
    const r = shrk(['--cwd', root, 'dev', 'commands', id, '--json'], root);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { commands: Record<string, string> };
    expect(out.commands.apply).toContain('shrk apply');
    expect(out.commands.applyWithSession).toContain(`--session ${id}`);
  });

  test('dev open prints session paths', () => {
    const root = makeFixture();
    shrk(['--cwd', root, 'dev', 'start', 'open-test'], root);
    const sessionsDir = join(root, '.sharkcraft', 'sessions');
    const id = readdirSync(sessionsDir).sort()[0]!;
    const r = shrk(['--cwd', root, 'dev', 'open', id, '--json'], root);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { dir: string };
    expect(out.dir).toContain(id);
  });
});
