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
  const root = mkdtempSync(join(tmpdir(), 'shrk-apply-divforce-'));
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

const TARGET_REL = 'src/services/demo.service.ts';

/**
 * Save a clean plan, then tamper its `expectedChanges[].sizeBytes` so a fresh
 * regen against the unchanged template diverges (size-changed). The tampered
 * size only drives divergence detection — the real write still emits the real
 * content. Returns the absolute plan path.
 */
function makeDivergentPlan(root: string): string {
  const planPath = join(root, 'plan.json');
  const save = shrk([
    '--cwd', root,
    'gen', 'typescript.service', 'demo',
    '--var', 'className=DemoService',
    '--dry-run',
    '--save-plan', planPath,
  ]);
  expect(save.status).toBe(0);
  expect(existsSync(planPath)).toBe(true);

  const saved = JSON.parse(readFileSync(planPath, 'utf8'));
  expect(Array.isArray(saved.expectedChanges)).toBe(true);
  expect(saved.expectedChanges.length).toBeGreaterThan(0);
  // Drift the recorded size so the live regen no longer matches.
  for (const change of saved.expectedChanges) {
    change.sizeBytes = (change.sizeBytes ?? 0) + 1000;
  }
  writeFileSync(planPath, JSON.stringify(saved));
  return planPath;
}

describe('shrk apply — --force does not bypass divergence (G3-3)', () => {
  test('--force alone refuses a divergent plan (exit 1 + "Plan diverged")', () => {
    const root = makeFixture();
    const planPath = makeDivergentPlan(root);

    const applied = shrk(['apply', planPath, '--force']);
    expect(applied.status).toBe(1);
    expect(applied.stdout).toContain('Plan diverged');
    // Refused: nothing written.
    expect(existsSync(join(root, TARGET_REL))).toBe(false);
  });

  test('--allow-divergent applies the live plan (exit 0)', () => {
    const root = makeFixture();
    const planPath = makeDivergentPlan(root);

    const applied = shrk(['apply', planPath, '--allow-divergent']);
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain('Applied.');
    expect(existsSync(join(root, TARGET_REL))).toBe(true);
    expect(readFileSync(join(root, TARGET_REL), 'utf8')).toBe(
      'export class DemoService {}\n',
    );
  });

  test('--force --allow-divergent applies the live plan (exit 0)', () => {
    const root = makeFixture();
    const planPath = makeDivergentPlan(root);

    const applied = shrk(['apply', planPath, '--force', '--allow-divergent']);
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain('Applied.');
    expect(existsSync(join(root, TARGET_REL))).toBe(true);
  });
});
