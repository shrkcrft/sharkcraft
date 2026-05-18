import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');

function shrk(args: readonly string[], cwd: string = REPO_ROOT): {
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
  const root = mkdtempSync(join(tmpdir(), 'shrk-apply-cli-'));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  mkdirSync(join(root, 'sharkcraft', 'node_modules', '@shrkcrft'), { recursive: true });
  // Symlink each workspace package the fixture needs.
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
    JSON.stringify({ name: 'apply-fixture', version: '0.0.0' }),
  );
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default {\n  projectName: 'apply-fixture',\n  knowledgeFiles: [],\n  ruleFiles: [],\n  pathFiles: [],\n  templateFiles: ['templates.ts'],\n  docsFiles: [],\n};\n`,
  );
  writeFileSync(
    join(root, 'sharkcraft', 'templates.ts'),
    `export const tsService = {\n  id: 'typescript.service',\n  name: 'Service',\n  description: 'A service.',\n  tags: ['ts'],\n  scope: ['ts'],\n  appliesWhen: ['generate-service'],\n  variables: [\n    { name: 'name', required: true },\n    { name: 'className', required: true },\n  ],\n  targetPath: ({ name }) => 'src/services/' + name + '.service.ts',\n  content: ({ className }) => 'export class ' + className + ' {}\\n',\n};\nexport default [tsService];\n`,
  );
  return root;
}

describe('shrk apply (end-to-end via spawn)', () => {
  test('apply writes files for a clean plan', () => {
    const root = makeFixture();
    const planPath = join(root, 'plan.json');

    // Step 1: save a plan via --save-plan.
    const save = shrk(
      [
        '--cwd', root,
        'gen', 'typescript.service', 'demo',
        '--var', 'className=DemoService',
        '--dry-run',
        '--save-plan', planPath,
      ],
    );
    expect(save.status).toBe(0);
    expect(existsSync(planPath)).toBe(true);
    const saved = JSON.parse(readFileSync(planPath, 'utf8'));
    expect(saved.schema).toBe('sharkcraft.plan/v1');
    expect(saved.templateId).toBe('typescript.service');

    // Step 2: apply the plan.
    const applied = shrk(['apply', planPath]);
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain('Applied.');
    expect(existsSync(join(root, 'src/services/demo.service.ts'))).toBe(true);
    expect(readFileSync(join(root, 'src/services/demo.service.ts'), 'utf8')).toBe(
      'export class DemoService {}\n',
    );
  });

  test('apply refuses missing required variable', () => {
    const root = makeFixture();
    const planPath = join(root, 'plan.json');
    // Hand-craft a plan with no className variable.
    writeFileSync(
      planPath,
      JSON.stringify({
        schema: 'sharkcraft.plan/v1',
        templateId: 'typescript.service',
        name: 'demo',
        variables: { className: 'DemoService' }, // valid first
        projectRoot: root,
        createdAt: '2026-05-01T00:00:00Z',
        expectedChanges: [
          { type: 'create', relativePath: 'src/services/demo.service.ts', sizeBytes: 27 },
        ],
      }),
    );
    // Now tamper: remove className.
    writeFileSync(
      planPath,
      JSON.stringify({
        schema: 'sharkcraft.plan/v1',
        templateId: 'typescript.service',
        name: 'demo',
        variables: {},
        projectRoot: root,
        createdAt: '2026-05-01T00:00:00Z',
        expectedChanges: [
          { type: 'create', relativePath: 'src/services/demo.service.ts', sizeBytes: 27 },
        ],
      }),
    );
    const r = shrk(['apply', planPath]);
    expect(r.status).not.toBe(0);
  });

  test('apply refuses a bad-schema plan', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-apply-bad-'));
    const planPath = join(root, 'bad.json');
    writeFileSync(planPath, JSON.stringify({ schema: 'unknown', templateId: 'x' }));
    const r = shrk(['apply', planPath]);
    expect(r.status).not.toBe(0);
  });

  test('apply errors when plan file is missing', () => {
    const r = shrk(['apply', '/no/such/plan.json']);
    expect(r.status).not.toBe(0);
  });
});
