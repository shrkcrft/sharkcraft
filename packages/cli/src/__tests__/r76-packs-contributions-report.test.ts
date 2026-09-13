/**
 * r76 — `shrk packs contributions` is THE contributions report (round 12,
 * ONE-CHANGE): a `By file:` section and JSON `report`, settled 0 / 1 / 2.
 *
 *   - an entry a loader rejected → 1 (it does not take effect);
 *   - only references whose kind's registry is empty → 2 NOT VERIFIED, in
 *     text and `--json` alike (never a ✓ over what could not be checked);
 *   - everything accepted, nothing unresolvable → 0 with the ✓ line;
 *   - `--pack` narrows the files AND the verdict to that pack.
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

function workspace(packs: readonly IPackSpec[]): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r76-contrib-'));
  roots.push(root);
  const write = (rel: string, body: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  write('package.json', JSON.stringify({ name: 'fx', version: '0.0.0' }));
  write('sharkcraft/sharkcraft.config.ts', "export default { projectName: 'fx' };\n");
  write('src/a.ts', 'export const a = 1;\n');
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

const CLEAN: IPackSpec = {
  name: '@r76/clean',
  manifest: { conventionFiles: ['./conventions.ts'] },
  files: { 'conventions.ts': "export default [{ id: 'cv.ok', title: 'Ok', kind: 'naming', severity: 'warning', rules: [] }];\n" },
};
const REJECTING: IPackSpec = {
  name: '@r76/bad',
  manifest: { conventionFiles: ['./conventions.ts'] },
  files: {
    'conventions.ts':
      "export default [\n  { id: 'cv.good', title: 'Good', kind: 'naming', severity: 'warning', rules: [] },\n  { id: 'cv.nosev', title: 'No severity', kind: 'naming', rules: [] },\n];\n",
  },
};
const UNRESOLVABLE: IPackSpec = {
  name: '@r76/refs',
  manifest: { registrationHintFiles: ['./registrations.ts'] },
  files: {
    'registrations.ts':
      "export default [{ id: 'reg.refs', title: 'Refs', discovery: { targetFile: 'src/a.ts', conventionIds: ['cv.nowhere'] }, operations: [{ kind: 'append', snippet: 'x' }] }];\n",
  },
};

describe('r76 packs contributions — the per-file report and its 0/1/2 verdict', () => {
  test(
    'a rejected entry → 1: the By-file row names it, text ≡ --json',
    () => {
      const root = workspace([REJECTING]);
      const text = shrk(root, ['packs', 'contributions']);
      expect(text.status).toBe(1);
      expect(text.stdout).toContain('By file (1): 2 declared · 1 accepted · 1 rejected');
      expect(text.stdout).toContain(
        "✗ node_modules/@r76/bad/conventions.ts  convention [@r76/bad]  2 declared · 1 accepted · 1 rejected",
      );
      expect(text.stdout).toContain("rejected      'cv.nosev' (default[1]) — severity:");
      expect(text.stdout).toContain('Contributions need attention: 1 rejected entry');
      const json = shrk(root, ['packs', 'contributions', '--json']);
      expect(json.status).toBe(1);
      const out = JSON.parse(json.stdout) as {
        exitCode: number;
        verdict: string;
        rejections: unknown[];
        report: { totals: Record<string, number> };
      };
      expect({ exit: out.exitCode, verdict: out.verdict, rejections: out.rejections.length }).toEqual({
        exit: 1,
        verdict: 'fail',
        rejections: 1,
      });
      expect(out.report.totals).toMatchObject({ files: 1, declared: 2, accepted: 1, rejected: 1 });
    },
    TIMEOUT_MS,
  );

  test(
    'only an unresolvable reference → 2 NOT VERIFIED, in text and --json',
    () => {
      const root = workspace([UNRESOLVABLE]);
      const text = shrk(root, ['packs', 'contributions']);
      expect(text.status).toBe(2);
      expect(text.stdout).toContain(
        "unresolvable  reg.refs discovery.conventionIds → convention 'cv.nowhere' — this kind's registry is empty here",
      );
      expect(text.stdout).toContain('NOT VERIFIED');
      expect(text.stdout).not.toMatch(/\.\s*✓/);
      const json = shrk(root, ['packs', 'contributions', '--json']);
      expect(json.status).toBe(2);
      const out = JSON.parse(json.stdout) as { exitCode: number; verdict: string; shortfalls: string[]; report: { totals: { unresolvable: number } } };
      expect({ exit: out.exitCode, verdict: out.verdict, unresolvable: out.report.totals.unresolvable }).toEqual({
        exit: 2,
        verdict: 'not-verified',
        unresolvable: 1,
      });
      expect(out.shortfalls.join(' ')).toContain('contributed references');
    },
    TIMEOUT_MS,
  );

  test(
    'everything accepted, nothing unresolvable → 0 with the ✓ line',
    () => {
      const root = workspace([CLEAN]);
      const text = shrk(root, ['packs', 'contributions']);
      expect(text.status).toBe(0);
      expect(text.stdout).toContain('✓ node_modules/@r76/clean/conventions.ts  convention [@r76/clean]  1 declared · 1 accepted');
      expect(text.stdout).toContain('1 of 1 declared entry accepted across 1 contributed file(s); no rejected entry, load failure or error conflict. ✓');
    },
    TIMEOUT_MS,
  );

  test(
    '--pack narrows the files and the verdict to that pack',
    () => {
      const root = workspace([CLEAN, REJECTING]);
      expect(shrk(root, ['packs', 'contributions']).status).toBe(1);
      const clean = shrk(root, ['packs', 'contributions', '--pack', '@r76/clean', '--json']);
      expect(clean.status).toBe(0);
      const out = JSON.parse(clean.stdout) as { report: { files: { packageName?: string }[] } };
      expect([...new Set(out.report.files.map((f) => f.packageName))]).toEqual(['@r76/clean']);
      expect(shrk(root, ['packs', 'contributions', '--pack', '@r76/bad']).status).toBe(1);
    },
    TIMEOUT_MS,
  );
});
