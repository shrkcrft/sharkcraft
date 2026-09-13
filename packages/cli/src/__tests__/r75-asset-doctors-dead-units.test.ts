/**
 * r75 — a dead unit is never a pass (spec 1.3 / 1.6, the coverage contract).
 *
 * The self-config / scaffold doctors printed "healthy" and exited 0 over a
 * `matchPaths` glob that matched nothing. Dead units now report through the
 * engine's coverage: the settled exit is 2 (verdict `unverified`), text and
 * `--json` agree, the ✓ line appears only at 0, and `--fail-on-dead-units`
 * turns a dead unit into 1. Spawned from source against real workspaces.
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

function shrk(cwd: string, argv: readonly string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('bun', ['run', CLI_MAIN, ...argv], { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-deadunits-'));
  roots.push(root);
  const all: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'fx' };\n`,
    'src/a.ts': 'export const a = 1;\n',
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

const DEAD_PATTERN = `export default [{
  id: 'sp.dead', title: 'Dead', description: 'points at a renamed directory', templateId: 'fx.none',
  matchPaths: ['src/old/**/*.service.ts'], variables: [], appliesWhen: ['infer-template'], confidence: 'high',
}];
`;

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe('r75 — dead units settle to NOT VERIFIED', () => {
  test(
    'self-config doctor: a clean workspace passes with the ✓ line (exit 0)',
    () => {
      const res = shrk(workspace({}), ['self-config', 'doctor']);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('✓');
      expect(res.stdout).not.toContain('NOT VERIFIED');
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    'self-config doctor: a dead scaffold glob → 2 in text AND --json, no ✓; --fail-on-dead-units → 1',
    () => {
      const root = workspace({ 'sharkcraft/scaffold-patterns.ts': DEAD_PATTERN });
      const text = shrk(root, ['self-config', 'doctor']);
      expect(text.status).toBe(2);
      expect(text.stdout).toContain('NOT VERIFIED');
      expect(text.stdout).toContain('scaffold patterns: examined 0 of 1 matchPaths globs');
      expect(text.stdout).not.toMatch(/✓/);
      const json = shrk(root, ['self-config', 'doctor', '--json']);
      const report = JSON.parse(json.stdout) as { verdict: string; exitCode: number; deadUnits: string[]; findings: { code: string }[] };
      expect(json.status).toBe(2);
      expect(report.exitCode).toBe(2);
      expect(report.verdict).toBe('unverified');
      expect(report.deadUnits.length).toBeGreaterThan(0);
      expect(report.findings.map((f) => f.code)).toContain('scaffold-pattern-matchPaths-matched-nothing');
      // v1 is the same doctor: same exit.
      expect(shrk(root, ['self-config', 'doctor', '--schema', 'v1', '--json']).status).toBe(2);
      expect(shrk(root, ['self-config', 'doctor', '--fail-on-dead-units']).status).toBe(1);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    'scaffolds doctor: text exit == --json exitCode == 2; --exit-trailer names it (a registered verdict verb)',
    () => {
      const root = workspace({ 'sharkcraft/scaffold-patterns.ts': DEAD_PATTERN });
      const json = shrk(root, ['scaffolds', 'doctor', '--json']);
      const body = JSON.parse(json.stdout) as { exitCode: number; dead: number; coverage: unknown[] };
      expect(json.status).toBe(2);
      expect(body.exitCode).toBe(2);
      expect(body.dead).toBe(2);
      const text = shrk(root, ['scaffolds', 'doctor', '--exit-trailer']);
      expect(text.status).toBe(2);
      expect(text.stdout).toContain('NOT VERIFIED');
      expect(text.stderr).toContain('shrk-exit: 2');
    },
    SPAWN_TIMEOUT_MS,
  );
});
