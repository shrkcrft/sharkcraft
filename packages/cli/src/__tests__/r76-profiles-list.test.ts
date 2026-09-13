/**
 * r76 — `shrk profiles` refuses what it does not know and names only real
 * declaration paths (round 12, 12.3a).
 *
 * `profiles list` printed "(none — contribute via packs: migrationProfileFiles,
 * etc.)" — "etc." named nothing, and the local `sharkcraft/migration-profiles.ts`
 * went unmentioned — and an unknown `--kind` was dropped silently, listing
 * every kind. The empty state now renders from THE declaration table, `--kind`
 * is a closed set, and the builtin `workspace` kind lists the WorkspaceProfile
 * vocabulary with this repo's detection. Spawned from source against real
 * workspaces; the list verbs the declaration table names are proven live
 * against THE command index.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ALL_ID_REFERENCE_KINDS,
  CommandResolutionStatus,
  REFERENCE_KIND_DECLARATIONS,
} from '@shrkcrft/inspector';
import { CONTRIBUTION_FILE_KEYS } from '@shrkcrft/plugin-api';
import { WorkspaceProfile } from '@shrkcrft/workspace';
import { buildRegistry } from '../main.ts';
import { buildCommandIndex } from '../surface/command-index.ts';
import { resolveCommandString } from '../surface/resolve-command-string.ts';

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

function workspace(files: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r76-profiles-'));
  roots.push(root);
  const all: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0', devDependencies: { typescript: '^5.0.0' } }),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

describe('r76 profiles list / get', () => {
  test(
    'an unknown --kind is a usage error naming the known kinds (it used to list every kind)',
    () => {
      const res = shrk(workspace(), ['profiles', 'list', '--kind', 'bogus']);
      // Non-verdict verb: THE usage split (`usageExitFor`) exits 2, never 0.
      expect(res.status).toBe(2);
      expect(res.stderr).toContain('unknown --kind "bogus"');
      expect(res.stderr).toContain('known: migration, workspace');
      expect(res.stdout).not.toContain('Profiles (');
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    'the empty state names only real declaration paths — from THE table, never "etc."',
    () => {
      const res = shrk(workspace(), ['profiles', 'list', '--kind', 'migration']);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('Profiles (0, kind=migration)');
      expect(res.stdout).toContain('migrationProfileFiles');
      expect(res.stdout).toContain('sharkcraft/migration-profiles.ts');
      expect(res.stdout).not.toContain('etc.');
      const keys = [...res.stdout.matchAll(/pack key (\w+)/g)].map((m) => m[1]!);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.filter((k) => !(CONTRIBUTION_FILE_KEYS as readonly string[]).includes(k))).toEqual([]);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    'an EMPTY project lists the builtin workspace vocabulary; has-typescript is marked detected',
    () => {
      const root = workspace();
      const json = shrk(root, ['profiles', 'list', '--json']);
      expect(json.status).toBe(0);
      const entries = JSON.parse(json.stdout) as { id: string; kind: string; source: string; detected?: boolean }[];
      const ws = entries.filter((e) => e.kind === 'workspace');
      expect(ws.map((e) => e.id).sort()).toEqual([...Object.values(WorkspaceProfile)].sort());
      expect(ws.every((e) => e.source === 'builtin')).toBe(true);
      expect(ws.find((e) => e.id === 'has-typescript')?.detected).toBe(true);
      const text = shrk(root, ['profiles', 'list', '--kind', 'workspace']);
      expect(text.status).toBe(0);
      expect(text.stdout).toMatch(/has-typescript\s+uses TypeScript\s+\[builtin · detected\]/);
      expect(text.stdout).toMatch(/has-angular\s+uses Angular\s+\[builtin\]/);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    '`profiles get` resolves a workspace profile, and a typo gets a did-you-mean (exit unchanged)',
    () => {
      const root = workspace();
      const ok = shrk(root, ['profiles', 'get', 'has-typescript']);
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain('Profile has-typescript (workspace)');
      expect(ok.stdout).toMatch(/detected\s+yes/);
      const typo = shrk(root, ['profiles', 'get', 'has-typscript']);
      expect(typo.status).toBe(2);
      expect(typo.stderr).toContain('Did you mean: has-typescript');
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe('r76 — every declaration list verb is a live command', () => {
  test('each REFERENCE_KIND_DECLARATIONS listVerb resolves Ok against THE command index', () => {
    const index = buildCommandIndex(buildRegistry());
    const bad = ALL_ID_REFERENCE_KINDS.map((kind) => ({
      kind,
      verb: REFERENCE_KIND_DECLARATIONS[kind].listVerb,
      status: resolveCommandString(index, REFERENCE_KIND_DECLARATIONS[kind].listVerb).status,
    })).filter((r) => r.status !== CommandResolutionStatus.Ok);
    expect(bad).toEqual([]);
  });
});
