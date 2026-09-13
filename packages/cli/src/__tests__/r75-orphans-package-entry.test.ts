/**
 * r75 — "is the index current?" for the orphan check includes the PACKAGE half
 * of the one freshness authority (round 11 review OA-2).
 *
 * `computeDeletedOrphans` read only added + modified files, dropping
 * `packagesChanged` — which `graphFreshnessBehind`, `graph status`, doctor and
 * the dashboard all count. After a package.json `main` edit, a bare `import …
 * from '@fx/a'` resolves to a file the stale index never linked, so deleting
 * that file hid a real orphan behind a clean 0. A package divergence the
 * delete itself explains (the indexed entry FILE was deleted) stays clean.
 *
 * Real temp git repos (git runs only inside them), a real code-graph index,
 * the real `check orphans` / `impact --deleted` handlers and `finish`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildFullIndex, detectGraphFreshness } from '@shrkcrft/graph';
import type { ParsedArgs } from '../command-registry.ts';
import { checkCommand } from '../commands/check.command.ts';
import { impactCommand } from '../commands/impact.command.ts';
import { ExitCode } from '../exit-codes.ts';
import { runFinishGates } from '../finish/run-finish.ts';

const SLOW = 120_000;

function args(root: string, positional: string[], flags: Record<string, string | boolean> = {}): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>([['cwd', root], ...Object.entries(flags)]),
    multiFlags: new Map(),
  };
}

async function run(
  h: { run(a: ParsedArgs): Promise<number> | number },
  a: ParsedArgs,
): Promise<{ code: number; out: string }> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = '';
  const sink = ((c: string | Uint8Array): boolean => {
    out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = sink;
  process.stderr.write = sink as typeof process.stderr.write;
  try {
    return { code: await h.run(a), out };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** git inside the fixture's own temp repo — never the working tree. */
function git(root: string, ...a: string[]): void {
  const res = spawnSync('git', ['-c', 'user.email=r75@test', '-c', 'user.name=r75', '-c', 'commit.gpgsign=false', ...a], {
    cwd: root,
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${res.stderr ?? ''}`);
}

function commitAll(root: string, message: string): void {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
}

/**
 * A two-package workspace: @fx/a (entry `main`), and optionally @fx/b whose
 * use.ts imports '@fx/a' bare. Committed and indexed.
 */
function workspace(main: string, withImporter: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-pkgentry-'));
  roots.push(root);
  const files: Record<string, string> = {
    '.gitignore': '.sharkcraft/\n',
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0', private: true, workspaces: ['packages/*'] }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler', target: 'es2022' } }),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
    'packages/a/package.json': JSON.stringify({ name: '@fx/a', version: '0.0.0', main }),
    'packages/a/src/a.ts': 'export const u = 1;\n',
    'packages/a/src/index.ts': 'export const u = 2;\n',
    ...(withImporter
      ? {
          'packages/b/package.json': JSON.stringify({ name: '@fx/b', version: '0.0.0', dependencies: { '@fx/a': '0.0.0' } }),
          'packages/b/src/use.ts': "import { u } from '@fx/a';\nexport const x = u;\n",
        }
      : {}),
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  git(root, 'init', '-q');
  commitAll(root, 'init');
  buildFullIndex({ projectRoot: root });
  return root;
}

const notVerifiedLine = (out: string): string => out.split('\n').find((l) => l.startsWith('NOT VERIFIED:')) ?? '';

describe('orphans over an index whose PACKAGE ENTRY changed (OA-2)', () => {
  test('STALE: main edited after the index, then the new entry deleted — 2 in check orphans, impact --deleted and finish', async () => {
    const root = workspace('src/a.ts', true);
    writeFileSync(
      join(root, 'packages/a/package.json'),
      JSON.stringify({ name: '@fx/a', version: '0.0.0', main: 'src/index.ts' }),
    );
    commitAll(root, 'entry moves to index.ts');
    unlinkSync(join(root, 'packages/a/src/index.ts'));
    // The one freshness authority calls this index stale.
    expect(detectGraphFreshness(root).packagesChanged).toContain('@fx/a');

    const text = await run(checkCommand, args(root, ['orphans'], { since: 'HEAD' }));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).toMatch(/^ +index +stale — package entry changed \(@fx\/a\)$/m);
    expect(notVerifiedLine(text.out)).toContain('package entry changed');
    const json = JSON.parse((await run(checkCommand, args(root, ['orphans'], { since: 'HEAD', json: true }))).out) as {
      gate: { exit: number };
      indexDivergence: { packagesChanged?: string[] };
    };
    expect({ exit: json.gate.exit, packages: json.indexDivergence.packagesChanged }).toEqual({ exit: 2, packages: ['@fx/a'] });

    expect((await run(impactCommand, args(root, [], { deleted: true, since: 'HEAD' }))).code).toBe(ExitCode.NotVerified);

    const finish = await runFinishGates({ cwd: root, mode: 'since', scope: { projectRoot: root, since: 'HEAD' } });
    expect(finish.gates.find((g) => g.name === 'orphans')?.status).toBe('partial');
    expect(finish.exit).toBe(ExitCode.NotVerified);
  }, SLOW);

  test('CONTROL: the entry was the indexed one — its deletion explains the divergence; the importer is found (1)', async () => {
    const root = workspace('src/index.ts', true);
    unlinkSync(join(root, 'packages/a/src/index.ts'));
    const json = JSON.parse((await run(checkCommand, args(root, ['orphans'], { since: 'HEAD', json: true }))).out) as {
      gate: { exit: number };
      indexDivergence: { packagesChanged?: string[] };
    };
    expect(json.gate.exit).toBe(ExitCode.Failure);
    expect(json.indexDivergence.packagesChanged).toBeUndefined();
  }, SLOW);

  test('CLEAN: deleting an indexed entry nothing imports, over a current index, reads clean (0)', async () => {
    const root = workspace('src/index.ts', false);
    unlinkSync(join(root, 'packages/a/src/index.ts'));
    expect((await run(checkCommand, args(root, ['orphans'], { since: 'HEAD' }))).code).toBe(ExitCode.VerifiedPass);
  }, SLOW);
});
