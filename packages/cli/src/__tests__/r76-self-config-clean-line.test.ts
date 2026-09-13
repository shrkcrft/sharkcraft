/**
 * r76 — the self-config doctor's exit-0 line says "every checked probe
 * resolved ✓" only when that is true (round 12, 12.3d).
 *
 * An INFO-severity unresolved id (a registration hint's `profileIds` typo, now
 * that 12.3 makes it measurable) never fails the run — but the clean line used
 * to read only `totals.warning`, so it printed "No cross-reference issues —
 * every checked probe resolved ✓" right under the finding that said it did not.
 * Spawned from source against real workspaces.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const SPAWN_TIMEOUT_MS = 180_000;
const roots: string[] = [];

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function shrk(cwd: string, argv: readonly string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('bun', ['run', CLI_MAIN, '--no-hints', ...argv], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function workspace(profileIds: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r76-cleanline-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0', devDependencies: { typescript: '^5.0.0' } }),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
    'src/app.reg.ts': 'export const registry = [];\n',
    'sharkcraft/registration-hints.ts': `export default [{ id: 'rh.one', title: 'One', discovery: { targetFile: 'src/app.reg.ts', profileIds: ${JSON.stringify(profileIds)} }, operations: [{ kind: 'append', snippet: 'x' }] }];\n`,
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

/** A pipeline step naming a construct: it resolves — as a kind the step does not accept (round 12, 12.4). */
function wrongKindWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r76-cleanline-wk-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0', devDependencies: { typescript: '^5.0.0' } }),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx', pipelineFiles: ['pipelines.ts'] };\n",
    'src/index.ts': 'export const x = 1;\n',
    'sharkcraft/constructs.ts':
      "export default [{ id: 'fx-construct', type: 'service', title: 'Fixture construct', files: ['src/index.ts'], publicApi: ['src/index.ts'] }];\n",
    'sharkcraft/pipelines.ts':
      "export default [{ id: 'fx.pipe', title: 'Pipe', description: 'A pipeline.', steps: [{ id: 's1', title: 'Step', type: 'agent', references: ['fx-construct'] }] }];\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

describe('r76 self-config doctor clean line', () => {
  test(
    'an info-level WRONG-KIND reference: exit 0, labelled as what it is, counted — never "every checked probe resolved"',
    () => {
      const res = shrk(wrongKindWorkspace(), ['self-config', 'doctor']);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('[pipeline-reference-wrong-kind] pipeline:fx.pipe references construct:fx-construct');
      expect(res.stdout).not.toContain('unknown:fx-construct');
      expect(res.stdout).not.toContain('every checked probe resolved');
      expect(res.stdout).toContain('1 wrong-kind reference(s) reported as info above');
      expect(res.stdout).not.toContain('✓');
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    'an info-level unresolved id: exit 0, counted — never "every checked probe resolved"',
    () => {
      const res = shrk(workspace(['has-typscript']), ['self-config', 'doctor']);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('[registration-hint-profile-missing]');
      expect(res.stdout).not.toContain('every checked probe resolved');
      expect(res.stdout).toContain('1 unresolved reference(s) reported as info above');
      expect(res.stdout).not.toContain('✓');
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    'a WARNING next to an info-level unresolved id: exit 0, both counted in one sentence — never "every checked probe resolved" (round 12 review, T6)',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'shrk-r76-cleanline-warn-'));
      roots.push(root);
      const files: Record<string, string> = {
        'package.json': JSON.stringify({ name: 'fx', version: '0.0.0', devDependencies: { typescript: '^5.0.0' } }),
        'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
        'src/app.reg.ts': 'export const registry = [];\n',
        // template-profile-missing is a WARNING…
        'sharkcraft/templates.ts':
          "export default [{ id: 'tpl.one', name: 'One', description: 'd', tags: [], scope: [], appliesWhen: [], variables: [], targetPath: () => 'src/x.ts', content: () => 'x', metadata: { requiredProfileIds: ['nope'] } }];\n",
        // …registration-hint-profile-missing is INFO.
        'sharkcraft/registration-hints.ts':
          "export default [{ id: 'rh.one', title: 'One', discovery: { targetFile: 'src/app.reg.ts', profileIds: ['has-typscript'] }, operations: [{ kind: 'append', snippet: 'x' }] }];\n",
      };
      for (const [rel, body] of Object.entries(files)) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), body);
      }
      const res = shrk(root, ['self-config', 'doctor']);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('[template-profile-missing]');
      expect(res.stdout).toContain('[registration-hint-profile-missing]');
      expect(res.stdout).toContain('1 warning(s) and 1 unresolved reference(s) reported above.');
      expect(res.stdout).not.toContain('every checked probe resolved');
      expect(res.stdout).not.toContain('✓');
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    'every id valid: the true sentence is unchanged (exit 0, ✓)',
    () => {
      const res = shrk(workspace(['has-typescript']), ['self-config', 'doctor']);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('every checked probe resolved');
      expect(res.stdout).toContain('✓');
    },
    SPAWN_TIMEOUT_MS,
  );
});
