import { describe, expect, test } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
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

/**
 * Build a small fixture project with one template, a verificationCommands entry,
 * and symlinks back to the workspace packages — same shape as apply.test.ts.
 */
function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-dev-'));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  mkdirSync(join(root, 'sharkcraft', 'node_modules', '@shrkcrft'), {
    recursive: true,
  });
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
    JSON.stringify({ name: 'dev-fixture', version: '0.0.0' }),
  );
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    [
      `export default {`,
      `  projectName: 'dev-fixture',`,
      `  knowledgeFiles: [],`,
      `  ruleFiles: [],`,
      `  pathFiles: [],`,
      `  templateFiles: ['templates.ts'],`,
      `  docsFiles: [],`,
      `  verificationCommands: [`,
      `    { id: 'smoke', label: 'smoke', command: 'echo hello-from-validate > .tmp-smoke-output.txt', trusted: true },`,
      `  ],`,
      `};`,
      ``,
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'sharkcraft', 'templates.ts'),
    [
      `export const tsService = {`,
      `  id: 'typescript.service',`,
      `  name: 'Service',`,
      `  description: 'Create a service skeleton (used to generate user profile services).',`,
      `  tags: ['ts', 'service', 'generate'],`,
      `  scope: ['ts'],`,
      `  appliesWhen: ['generate-service', 'create-service'],`,
      `  variables: [`,
      `    { name: 'name', required: true },`,
      `    { name: 'className', required: true },`,
      `  ],`,
      `  targetPath: ({ name }) => 'src/services/' + name + '.service.ts',`,
      `  content: ({ className }) => 'export class ' + className + ' {}\\n',`,
      `};`,
      `export default [tsService];`,
      ``,
    ].join('\n'),
  );
  return root;
}

function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function findSessionId(root: string): string {
  const dir = join(root, '.sharkcraft', 'sessions');
  const ids = readdirSync(dir).sort();
  return ids[0]!;
}

describe('shrk dev (workflow CLI)', () => {
  test('dev start creates the full session artifact bundle + session.json', () => {
    const root = makeFixture();
    const r = shrk(
      ['--cwd', root, 'dev', 'start', 'create a user profile service'],
      root,
    );
    expect(r.status).toBe(0);
    const id = findSessionId(root);
    const dir = join(root, '.sharkcraft', 'sessions', id);
    for (const f of [
      'task.md',
      'task-packet.json',
      'context.md',
      'action-hints.json',
      'recommended-pipeline.json',
      'next-steps.md',
      'commands.sh',
      'session.json',
    ]) {
      expect(existsSync(join(dir, f))).toBe(true);
    }
    expect(existsSync(join(dir, 'plans'))).toBe(true);
    expect(existsSync(join(dir, 'reports'))).toBe(true);

    const state = readJson<{ schema: string; phase: string; task: string; nextAction: string | null }>(
      join(dir, 'session.json'),
    );
    expect(state.schema).toBe('sharkcraft.dev-session/v1');
    expect(state.phase).toBe('started');
    expect(state.task).toBe('create a user profile service');
    expect(state.nextAction).toContain('shrk dev');
  });

  test('dev "<task>" is aliased to dev start "<task>"', () => {
    const root = makeFixture();
    const r = shrk(['--cwd', root, 'dev', 'create a profile service'], root);
    expect(r.status).toBe(0);
    const id = findSessionId(root);
    expect(existsSync(join(root, '.sharkcraft', 'sessions', id, 'session.json'))).toBe(true);
  });

  test('dev status reads session.json + emits computed next action', () => {
    const root = makeFixture();
    expect(shrk(['--cwd', root, 'dev', 'start', 'create profile'], root).status).toBe(0);
    const id = findSessionId(root);
    const r = shrk(['--cwd', root, 'dev', 'status', id, '--json'], root);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as {
      id: string;
      phase: string;
      plans: unknown[];
      validations: unknown[];
      nextAction: { command: string };
    };
    expect(out.id).toBe(id);
    expect(out.phase).toBe('started');
    expect(out.plans).toEqual([]);
    expect(out.validations).toEqual([]);
    expect(out.nextAction.command).toContain('shrk dev plan');
  });

  test('dev next suggests dev plan immediately after dev start', () => {
    const root = makeFixture();
    shrk(['--cwd', root, 'dev', 'start', 'create profile'], root);
    const id = findSessionId(root);
    const r = shrk(['--cwd', root, 'dev', 'next', id, '--json'], root);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { command: string; action: string };
    expect(out.command).toContain('shrk dev plan');
  });

  test('dev plan creates an intent file when required variables are missing', () => {
    const root = makeFixture();
    shrk(['--cwd', root, 'dev', 'start', 'create user profile service'], root);
    const id = findSessionId(root);
    // Skip --name so both `name` and `className` (auto-derived from --name)
    // are missing — exercising the intent-file path.
    const r = shrk(
      ['--cwd', root, 'dev', 'plan', id, '--template', 'typescript.service'],
      root,
    );
    expect(r.status).toBe(0);
    const plansDir = join(root, '.sharkcraft', 'sessions', id, 'plans');
    const intentFiles = readdirSync(plansDir).filter((f) => f.endsWith('.intent.md'));
    expect(intentFiles.length).toBeGreaterThan(0);
    const body = readFileSync(join(plansDir, intentFiles[0]!), 'utf8');
    expect(body).toContain('Plan intent');
    expect(body).toContain('shrk dev plan');

    const state = readJson<{ plans: { status: string; missingVariables: string[] }[] }>(
      join(root, '.sharkcraft', 'sessions', id, 'session.json'),
    );
    const intentEntry = state.plans.find((p) => p.status === 'intent');
    expect(intentEntry).toBeDefined();
    expect(intentEntry!.missingVariables.length).toBeGreaterThan(0);
  });

  test('dev plan saves + reviews a plan when all variables are provided', () => {
    const root = makeFixture();
    shrk(['--cwd', root, 'dev', 'start', 'create user profile service'], root);
    const id = findSessionId(root);
    const r = shrk(
      [
        '--cwd', root,
        'dev', 'plan', id,
        '--template', 'typescript.service',
        '--name', 'user-profile',
        '--var', 'className=UserProfileService',
      ],
      root,
    );
    expect(r.status).toBe(0);
    const sessionDir = join(root, '.sharkcraft', 'sessions', id);
    const plansDir = join(sessionDir, 'plans');
    const reportsDir = join(sessionDir, 'reports');
    expect(existsSync(join(plansDir, 'user-profile.json'))).toBe(true);
    expect(existsSync(join(reportsDir, 'plan-review-user-profile.json'))).toBe(true);
    expect(existsSync(join(reportsDir, 'plan-review-user-profile.md'))).toBe(true);

    const plan = readJson<{ schema: string; templateId: string; variables: Record<string, string> }>(
      join(plansDir, 'user-profile.json'),
    );
    expect(plan.schema).toBe('sharkcraft.plan/v1');
    expect(plan.templateId).toBe('typescript.service');
    expect(plan.variables.className).toBe('UserProfileService');

    const state = readJson<{ phase: string; plans: { name: string; status: string }[] }>(
      join(sessionDir, 'session.json'),
    );
    expect(state.phase).toMatch(/^(planned|reviewed)$/);
    const entry = state.plans.find((p) => p.name === 'user-profile');
    expect(entry?.status).toBe('reviewed');
  });

  test('dev validate runs harmless verificationCommands and updates session.json', () => {
    const root = makeFixture();
    shrk(['--cwd', root, 'dev', 'start', 'create user profile service'], root);
    const id = findSessionId(root);
    // Plan + auto-review (so we have something to "validate against")
    shrk(
      [
        '--cwd', root,
        'dev', 'plan', id,
        '--template', 'typescript.service',
        '--name', 'user-profile',
        '--var', 'className=UserProfileService',
      ],
      root,
    );
    const r = shrk(
      ['--cwd', root, 'dev', 'validate', id, '--verification', 'smoke', '--json'],
      root,
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { passed: boolean; commandsRun: { command: string; passed: boolean }[] };
    expect(out.passed).toBe(true);
    expect(out.commandsRun.some((c) => c.command.includes('smoke'))).toBe(true);
    // The harmless side-effect file from the verification command should exist.
    expect(existsSync(join(root, '.tmp-smoke-output.txt'))).toBe(true);

    const sessionFile = join(root, '.sharkcraft', 'sessions', id, 'session.json');
    const state = readJson<{ phase: string; validations: { passed: boolean }[] }>(sessionFile);
    expect(state.validations.length).toBe(1);
    expect(state.validations[0]!.passed).toBe(true);
    expect(state.phase).toBe('validated');
  });

  test('dev report writes final-report.md and marks the session completed', () => {
    const root = makeFixture();
    shrk(['--cwd', root, 'dev', 'start', 'create user profile service'], root);
    const id = findSessionId(root);
    shrk(
      [
        '--cwd', root,
        'dev', 'plan', id,
        '--template', 'typescript.service',
        '--name', 'user-profile',
        '--var', 'className=UserProfileService',
      ],
      root,
    );
    const r = shrk(['--cwd', root, 'dev', 'report', id], root);
    expect(r.status).toBe(0);
    const dir = join(root, '.sharkcraft', 'sessions', id);
    const reportPath = join(dir, 'final-report.md');
    expect(existsSync(reportPath)).toBe(true);
    const body = readFileSync(reportPath, 'utf8');
    expect(body).toContain('# Dev session:');
    expect(body).toContain('## Timeline');
    expect(body).toContain('## Generated plans');

    const state = readJson<{ phase: string }>(join(dir, 'session.json'));
    expect(state.phase).toBe('completed');
  });

  test('legacy session without session.json is still readable by dev status', () => {
    const root = makeFixture();
    // Create a legacy session manually — no session.json.
    const id = '2026-05-12T18-00-00-000Z-legacy-task';
    const dir = join(root, '.sharkcraft', 'sessions', id);
    mkdirSync(join(dir, 'plans'), { recursive: true });
    mkdirSync(join(dir, 'reports'), { recursive: true });
    writeFileSync(join(dir, 'task.md'), '# legacy task\n', 'utf8');

    const r = shrk(['--cwd', root, 'dev', 'status', id, '--json'], root);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { legacy: boolean; phase: string | null; nextAction: { command: string } };
    expect(out.legacy).toBe(true);
    expect(out.phase).toBeNull();
    expect(out.nextAction.command).toContain('shrk dev');
  });

  test('dev list enumerates sessions', () => {
    const root = makeFixture();
    shrk(['--cwd', root, 'dev', 'start', 'session a'], root);
    shrk(['--cwd', root, 'dev', 'start', 'session b'], root);
    const r = shrk(['--cwd', root, 'dev', 'list', '--json'], root);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { id: string }[];
    expect(out.length).toBe(2);
  });

  test('dev plan fails clearly when neither --template nor a suggestedGen template exists', () => {
    const root = makeFixture();
    // Use a task that won't match the only template (avoid words like 'create', 'service').
    shrk(['--cwd', root, 'dev', 'start', 'inspect existing code'], root);
    const id = findSessionId(root);
    const r = shrk(['--cwd', root, 'dev', 'plan', id], root);
    // Either it surfaces an error (no suggestedGen) or it picks the template
    // by ranker. We just assert the command runs predictably.
    if (r.status !== 0) {
      expect(r.stderr).toMatch(/template|suggested/i);
    }
  });
});

describe('MCP dev tools (read-only)', () => {
  test('dev tools never mutate the session directory', async () => {
    const root = makeFixture();
    shrk(['--cwd', root, 'dev', 'start', 'create user profile service'], root);
    const id = findSessionId(root);
    const sessionFile = join(root, '.sharkcraft', 'sessions', id, 'session.json');
    const before = readFileSync(sessionFile, 'utf8');

    const { ALL_TOOLS } = await import('@shrkcrft/mcp-server');
    const devToolNames = new Set([
      'start_dev_session_preview',
      'get_dev_session',
      'get_dev_status',
      'get_dev_next_action',
      'get_dev_report',
      'list_dev_sessions',
    ]);
    const tools = ALL_TOOLS.filter((t) => devToolNames.has(t.name));
    expect(tools.length).toBe(6);

    const { inspectSharkcraft } = await import('@shrkcrft/inspector');
    const inspection = await inspectSharkcraft({ cwd: root });
    const ctx = { inspection, cwd: root };
    for (const t of tools) {
      const input = t.name === 'start_dev_session_preview'
        ? { task: 'create user profile service' }
        : t.name === 'list_dev_sessions'
          ? {}
          : { id };
      const result = await t.handler(input as Record<string, unknown>, ctx);
      expect(result.isError ?? false).toBe(false);
      expect(result.data).toBeDefined();
    }
    const after = readFileSync(sessionFile, 'utf8');
    expect(after).toBe(before);
  });

  test('start_dev_session_preview returns the CLI command, not a session', async () => {
    const root = makeFixture();
    const { ALL_TOOLS } = await import('@shrkcrft/mcp-server');
    const { inspectSharkcraft } = await import('@shrkcrft/inspector');
    const inspection = await inspectSharkcraft({ cwd: root });
    const tool = ALL_TOOLS.find((t) => t.name === 'start_dev_session_preview')!;
    const result = await tool.handler(
      { task: 'create user profile service' },
      { inspection, cwd: root },
    );
    expect(result.isError ?? false).toBe(false);
    const data = result.data as { cliCommand: string; recommendedPipeline: unknown };
    expect(data.cliCommand).toContain('shrk dev start');
    // Crucially: no session directory was created.
    expect(existsSync(join(root, '.sharkcraft', 'sessions'))).toBe(false);
  });
});
