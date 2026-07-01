import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '@shrkcrft/graph';
import { checkCommand } from '../commands/check.command.ts';

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr ?? ''}`);
}

/**
 * Two-package fixture committed to a real git repo: `beta` imports + calls a
 * symbol from `alpha`. Returns the repo root with the index built while alpha
 * still exists — the pre-edit snapshot the orphan check runs against.
 */
function setupRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-check-orphans-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo-root', workspaces: ['packages/*'] }, null, 2),
  );
  mkdirSync(join(root, 'packages', 'alpha', 'src'), { recursive: true });
  mkdirSync(join(root, 'packages', 'beta', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'alpha', 'package.json'),
    JSON.stringify({ name: '@demo/alpha', main: 'src/index.ts' }, null, 2),
  );
  writeFileSync(
    join(root, 'packages', 'beta', 'package.json'),
    JSON.stringify({ name: '@demo/beta', main: 'src/index.ts' }, null, 2),
  );
  writeFileSync(
    join(root, 'packages', 'alpha', 'src', 'index.ts'),
    'export function alpha() { return 1; }\n',
  );
  writeFileSync(
    join(root, 'packages', 'beta', 'src', 'index.ts'),
    "import { alpha } from '@demo/alpha';\nexport function useAlpha() { return alpha(); }\n",
  );
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  buildFullIndex({ projectRoot: root });
  return root;
}

function args(root: string, extraFlags: Record<string, string | boolean> = {}): {
  positional: string[];
  flags: Map<string, string | boolean>;
  multiFlags: Map<string, string[]>;
} {
  const flags = new Map<string, string | boolean>([['cwd', root], ['json', true]]);
  for (const [k, v] of Object.entries(extraFlags)) flags.set(k, v);
  return { positional: ['orphans'], flags, multiFlags: new Map() };
}

function capture(): { restore: () => string } {
  const orig = process.stdout.write.bind(process.stdout);
  let body = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  return {
    restore() {
      process.stdout.write = orig;
      return body;
    },
  };
}

describe('shrk check orphans', () => {
  test('flags a surviving importer of a deleted file (exit 1, file:line)', async () => {
    const root = setupRepo();
    try {
      // Delete alpha in the working tree — the index still carries its edges.
      unlinkSync(join(root, 'packages', 'alpha', 'src', 'index.ts'));
      const cap = capture();
      const code = await checkCommand.run(args(root, { since: 'HEAD' }));
      const json = JSON.parse(cap.restore());
      expect(code).toBe(1);
      expect(json.schema).toBe('sharkcraft.deleted-orphans/v1');
      const orphan = json.orphans.find(
        (o: { path?: string }) => o.path === 'packages/beta/src/index.ts',
      );
      expect(orphan).toBeDefined();
      expect(orphan.deletedFile).toBe('packages/alpha/src/index.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reads a staged deletion via --staged', async () => {
    const root = setupRepo();
    try {
      // Stage the deletion: `git rm` removes from disk AND stages it.
      git(root, 'rm', '-q', 'packages/alpha/src/index.ts');
      const cap = capture();
      const code = await checkCommand.run(args(root, { staged: true }));
      const json = JSON.parse(cap.restore());
      expect(code).toBe(1);
      expect(
        json.orphans.some((o: { path?: string }) => o.path === 'packages/beta/src/index.ts'),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a RENAME (R100 name-status entry) treats the old path as deleted', async () => {
    const root = setupRepo();
    try {
      // `git mv` stages a rename → `R100\told\tnew` in --name-status --cached.
      // The old path is gone, so a surviving importer of it is an orphan; the
      // single-letter status regex used to drop the whole line and miss this.
      git(root, 'mv', 'packages/alpha/src/index.ts', 'packages/alpha/src/renamed.ts');
      const cap = capture();
      const code = await checkCommand.run(args(root, { staged: true }));
      const json = JSON.parse(cap.restore());
      expect(code).toBe(1);
      expect(json.resolvedDeleted).toContain('packages/alpha/src/index.ts');
      expect(
        json.orphans.some((o: { path?: string }) => o.path === 'packages/beta/src/index.ts'),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('loudly SKIPS (not a green pass) when nothing was deleted', async () => {
    const root = setupRepo();
    try {
      const cap = capture();
      const code = await checkCommand.run(args(root, { since: 'HEAD' }));
      const json = JSON.parse(cap.restore());
      expect(code).toBe(0);
      // A no-op sub-check is reported as skipped, not silently passed.
      expect(json.skipped).toBe(true);
      expect(json.orphans).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('no orphans when the deleted file had no surviving importers', async () => {
    const root = setupRepo();
    try {
      // Delete the LEAF importer (beta) — nothing imports it, so no orphans.
      unlinkSync(join(root, 'packages', 'beta', 'src', 'index.ts'));
      const cap = capture();
      const code = await checkCommand.run(args(root, { since: 'HEAD' }));
      const json = JSON.parse(cap.restore());
      expect(code).toBe(0);
      expect(json.orphans).toEqual([]);
      expect(json.resolvedDeleted).toContain('packages/beta/src/index.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
