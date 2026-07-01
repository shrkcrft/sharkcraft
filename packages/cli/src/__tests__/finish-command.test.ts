import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '@shrkcrft/graph';
import { finishCommand } from '../commands/finish.command.ts';

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr ?? ''}`);
}

function setupRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-finish-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
  );
  mkdirSync(join(root, 'packages', 'a', 'src'), { recursive: true });
  mkdirSync(join(root, 'packages', 'b', 'src'), { recursive: true });
  writeFileSync(join(root, 'packages', 'a', 'package.json'), JSON.stringify({ name: '@d/a', main: 'src/index.ts' }));
  writeFileSync(join(root, 'packages', 'b', 'package.json'), JSON.stringify({ name: '@d/b', main: 'src/index.ts' }));
  writeFileSync(join(root, 'packages', 'a', 'src', 'index.ts'), 'export function a() { return 1; }\n');
  writeFileSync(
    join(root, 'packages', 'b', 'src', 'index.ts'),
    "import { a } from '@d/a';\nexport function b() { return a(); }\n",
  );
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  buildFullIndex({ projectRoot: root });
  return root;
}

function args(root: string, positional: string[], flags: Record<string, string | boolean> = {}): {
  positional: string[];
  flags: Map<string, string | boolean>;
  multiFlags: Map<string, string[]>;
} {
  const f = new Map<string, string | boolean>([['cwd', root], ['json', true]]);
  for (const [k, v] of Object.entries(flags)) f.set(k, v);
  return { positional, flags: f, multiFlags: new Map() };
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

function gateByName(report: { gates: { name: string; status: string }[] }, name: string) {
  return report.gates.find((g) => g.name === name);
}

describe('shrk finish (composite gate)', () => {
  test('FAILS when a deletion orphans a surviving importer', async () => {
    const root = setupRepo();
    try {
      unlinkSync(join(root, 'packages', 'a', 'src', 'index.ts'));
      const cap = capture();
      const code = await finishCommand.run(args(root, [], { since: 'HEAD' }));
      const report = JSON.parse(cap.restore());
      expect(code).toBe(1);
      expect(report.verdict).toBe('fail');
      expect(gateByName(report, 'orphans')?.status).toBe('fail');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('PASSES a clean changeset, reporting skipped sub-gates loudly', async () => {
    const root = setupRepo();
    try {
      // Touch (not delete) a file so there is a changeset but no orphan.
      writeFileSync(join(root, 'packages', 'b', 'src', 'index.ts'), "import { a } from '@d/a';\nexport function b() { return a() + 1; }\n");
      const cap = capture();
      const code = await finishCommand.run(args(root, [], { since: 'HEAD' }));
      const report = JSON.parse(cap.restore());
      expect(code).toBe(0);
      expect(report.verdict).toBe('pass');
      // No sharkcraft config in the fixture → wiring/policy are skipped, NOT failed.
      expect(gateByName(report, 'wiring')?.status).toBe('skipped');
      expect(gateByName(report, 'policy')?.status).toBe('skipped');
      // Nothing deleted → orphans skipped (loud), not a green pass masking a no-op.
      expect(gateByName(report, 'orphans')?.status).toBe('skipped');
      // Absence of config must NOT force a fail.
      expect(report.configError).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('includes a best-effort impact summary when the graph is indexed', async () => {
    const root = setupRepo();
    try {
      writeFileSync(join(root, 'packages', 'a', 'src', 'index.ts'), 'export function a() { return 2; }\n');
      const cap = capture();
      await finishCommand.run(args(root, [], { since: 'HEAD' }));
      const report = JSON.parse(cap.restore());
      expect(report.impact.ran).toBe(true);
      expect(typeof report.impact.risk).toBe('string');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('--files scope skips the orphan gate (no diff to read deletions from)', async () => {
    const root = setupRepo();
    try {
      const cap = capture();
      const code = await finishCommand.run(args(root, ['packages/b/src/index.ts']));
      const report = JSON.parse(cap.restore());
      expect(code).toBe(0);
      expect(report.scope.mode).toBe('files');
      expect(gateByName(report, 'orphans')?.status).toBe('skipped');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
