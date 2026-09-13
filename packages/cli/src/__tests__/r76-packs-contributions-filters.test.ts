/**
 * r76 — `shrk packs contributions` cannot pass over a view it narrowed to
 * nothing (round 12 review, A-1), and a list verb names a contribution file
 * that failed to load (A-4).
 *
 *   - an unknown `--kind` (the plural typo `conventions`, `bogus`) or `--pack`
 *     is a usage error — exit 3 naming the known values and the nearest —
 *     never a ✓ at 0 over an empty view, even on a project with a rejected
 *     entry (it printed "0 of 0 declared entries accepted … ✓" and exited 0);
 *   - a view holding no contributed file (an empty project, or a real kind
 *     with nothing of it) is 2 NOT VERIFIED in text and --json alike, never ✓;
 *     `--allow-empty` accepts it explicitly — 0, with the acceptance printed;
 *   - `conventions list` over a conventions file that throws on import names
 *     the failure (stdout, and a stderr note under --json) and never points at
 *     that very file as the place to contribute.
 * Spawned from source against real temp workspaces with real packs.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const TIMEOUT_MS = 300_000;
const roots: string[] = [];

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function shrk(cwd: string, argv: readonly string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('bun', ['run', CLI_MAIN, '--no-hints', ...argv], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

type IPackSpec = { readonly name: string; readonly manifest: Record<string, readonly string[]>; readonly files: Readonly<Record<string, string>> };

function workspace(packs: readonly IPackSpec[], local: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r76-contrib-filters-'));
  roots.push(root);
  const write = (rel: string, body: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  write('package.json', JSON.stringify({ name: 'fx', version: '0.0.0' }));
  write('sharkcraft/sharkcraft.config.ts', "export default { projectName: 'fx' };\n");
  write('src/a.ts', 'export const a = 1;\n');
  for (const [rel, body] of Object.entries(local)) write(rel, body);
  for (const p of packs) {
    const dir = `node_modules/${p.name}`;
    write(`${dir}/package.json`, JSON.stringify({ name: p.name, version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }));
    write(
      `${dir}/manifest.json`,
      JSON.stringify({ schema: 'sharkcraft.pack/v1', info: { name: p.name, version: '0.0.1' }, contributions: p.manifest }),
    );
    for (const [rel, body] of Object.entries(p.files)) write(`${dir}/${rel}`, body);
  }
  return root;
}

/** The reviewer's F1 shape, reduced: one pack, one accepted and one rejected convention. */
const REJECTING: IPackSpec = {
  name: '@r76/bad',
  manifest: { conventionFiles: ['./conventions.ts'] },
  files: {
    'conventions.ts':
      "export default [\n  { id: 'cv.good', title: 'Good', kind: 'naming', severity: 'warning', rules: [] },\n  { id: 'cv.nosev', title: 'No severity', kind: 'naming', rules: [] },\n];\n",
  },
};

/** A clean verdict line: a sentence closing with ✓. Never printed on a 2 or a 3. */
const CLEAN = /\.\s*✓/;

describe('r76 packs contributions — a filter that selects nothing is never a pass', () => {
  test(
    'an unknown --kind or --pack is a usage error (3) naming the known values — even over a rejected entry',
    () => {
      const root = workspace([REJECTING]);
      const plural = shrk(root, ['packs', 'contributions', '--kind', 'conventions']);
      expect(plural.status).toBe(3);
      expect(plural.stderr).toContain('unknown --kind "conventions"');
      expect(plural.stderr).toContain('Did you mean: convention');
      expect(plural.stdout).not.toMatch(CLEAN);

      const bogus = shrk(root, ['packs', 'contributions', '--kind', 'bogus', '--json']);
      expect(bogus.status).toBe(3);
      expect(bogus.stdout.trim()).toBe('');

      const typo = shrk(root, ['packs', 'contributions', '--pack', '@r76/bda']);
      expect(typo.status).toBe(3);
      expect(typo.stderr).toContain('unknown --pack "@r76/bda" — known: @r76/bad.');
      expect(typo.stdout).not.toMatch(CLEAN);

      // A real kind and a real pack still carry the real verdict.
      expect(shrk(root, ['packs', 'contributions', '--kind', 'convention']).status).toBe(1);
      expect(shrk(root, ['packs', 'contributions', '--pack', '@r76/bad']).status).toBe(1);
    },
    TIMEOUT_MS,
  );

  test(
    'a real kind with nothing of it in view is 2 NOT VERIFIED, never ✓',
    () => {
      const root = workspace([REJECTING]);
      const helper = shrk(root, ['packs', 'contributions', '--kind', 'helper']);
      expect(helper.status).toBe(2);
      expect(helper.stdout).toContain('NOT VERIFIED');
      expect(helper.stdout).toContain('no contributed file matches --kind helper');
      expect(helper.stdout).not.toMatch(CLEAN);
    },
    TIMEOUT_MS,
  );

  test(
    'an empty project is 2 NOT VERIFIED in text and --json; --allow-empty accepts it explicitly',
    () => {
      const root = workspace([]);
      const text = shrk(root, ['packs', 'contributions']);
      expect(text.status).toBe(2);
      expect(text.stdout).toContain('NOT VERIFIED');
      expect(text.stdout).toContain('Pass --allow-empty to accept an empty view explicitly.');
      expect(text.stdout).not.toMatch(CLEAN);

      const json = shrk(root, ['packs', 'contributions', '--json']);
      expect(json.status).toBe(2);
      const out = JSON.parse(json.stdout) as { exitCode: number; verdict: string; shortfalls: string[] };
      expect({ exit: out.exitCode, verdict: out.verdict }).toEqual({ exit: 2, verdict: 'not-verified' });
      expect(out.shortfalls.join(' ')).toContain('contributed files');

      const accepted = shrk(root, ['packs', 'contributions', '--allow-empty']);
      expect(accepted.status).toBe(0);
      expect(accepted.stdout).toContain('accepted by --allow-empty');

      const noPack = shrk(root, ['packs', 'contributions', '--pack', '@r76/none']);
      expect(noPack.status).toBe(3);
      expect(noPack.stderr).toContain('no pack was discovered');
    },
    TIMEOUT_MS,
  );
});

describe('r76 list verbs — a contribution file that failed to load is named', () => {
  test(
    'conventions list names the failed file and never offers it as the place to contribute',
    () => {
      const root = workspace([], { 'sharkcraft/conventions.ts': "throw new Error('boom-r76-conventions');\nexport default [];\n" });
      const text = shrk(root, ['conventions', 'list']);
      expect(text.status).toBe(0);
      expect(text.stdout).toContain('⚠ sharkcraft/conventions.ts failed to load (');
      expect(text.stdout).toContain('boom-r76-conventions');
      expect(text.stdout).toContain('(none loaded — a conventions file failed to load; see below)');
      expect(text.stdout).not.toContain('contribute via');

      const json = shrk(root, ['conventions', 'list', '--json']);
      expect(json.status).toBe(0);
      expect(JSON.parse(json.stdout)).toEqual([]);
      expect(json.stderr).toContain('note: sharkcraft/conventions.ts failed to load (');
    },
    TIMEOUT_MS,
  );
});
