/**
 * r76 — ONE pack doctor (round 12 review, R12-X2).
 *
 * Only `shrk packs doctor` ran the async builder (`buildPackDoctorReportAsync`,
 * which runs the registry loaders and so sees their REJECTED entries). MCP
 * `doctor_packs` / `get_pack_doctor_release`, `shrk check packs`, the quality
 * report's `packs` row and release readiness called the sync builder without
 * those outcomes: on a pack whose two conventions were both refused by their
 * loader, `packs doctor` exited 1 while MCP said `passed: true, exitCode 0`,
 * `check packs` said `OK packs errors=0` and `quality` said `passed`.
 *
 * Parity over a REAL pack (under node_modules) and a real inspection: MCP
 * `doctor_packs` exitCode ≡ `packs doctor --json` exitCode ≡ `check packs`
 * exit, and the quality `packs` item is not `passed`. Plus a grep lock: no
 * source outside pack-doctor.ts calls the sync builder directly.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '../tools/all-tools.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const TIMEOUT_MS = 300_000;
const roots: string[] = [];

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const tool = (name: string) => {
  const t = ALL_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`MCP tool ${name} is not registered`);
  return t;
};

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

/** A pack whose only contribution is a conventions file with 2 of 2 entries refused by their loader. */
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r76-doctor-parity-'));
  roots.push(root);
  write(root, 'package.json', JSON.stringify({ name: 'fx', version: '0.0.0' }));
  write(root, 'sharkcraft/sharkcraft.config.ts', "export default { projectName: 'fx' };\n");
  write(root, 'src/a.ts', 'export const a = 1;\n');
  const dir = 'node_modules/@r76/cv';
  write(root, `${dir}/package.json`, JSON.stringify({ name: '@r76/cv', version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }));
  write(
    root,
    `${dir}/manifest.json`,
    JSON.stringify({ schema: 'sharkcraft.pack/v1', info: { name: '@r76/cv', version: '0.0.1' }, contributions: { conventionFiles: ['./conventions.ts'] } }),
  );
  write(
    root,
    `${dir}/conventions.ts`,
    "export default [\n  { id: 'conv.a', title: 'A', description: 'a', severity: 'warning', appliesTo: {}, rule: 'x' },\n  { id: 'conv.b', title: 'B', description: 'b', appliesTo: {}, rule: 'y' },\n];\n",
  );
  return root;
}

function shrk(cwd: string, argv: readonly string[]): { status: number; stdout: string } {
  const res = spawnSync('bun', ['run', CLI_MAIN, '--no-hints', ...argv], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '' };
}

describe('R12-X2 — every pack-doctor surface settles on the registry-backed rejections', () => {
  test(
    'MCP doctor_packs ≡ packs doctor --json ≡ check packs, and the quality packs item is not passed',
    async () => {
      const root = workspace();
      const inspection = await inspectSharkcraft({ cwd: root });
      const ctx = { inspection, cwd: root };

      const mcp = (await tool('doctor_packs').handler({}, ctx)).data as {
        passed: boolean;
        exitCode: number;
        issues: { code: string; message: string }[];
      };
      expect(mcp.issues.some((i) => i.code === 'contribution-entries-rejected' && i.message.includes('2 of 2 entries rejected'))).toBe(true);
      expect(mcp.passed).toBe(false);

      const release = (await tool('get_pack_doctor_release').handler({}, ctx)).data as { issues: { code: string }[] };
      expect(release.issues.some((i) => i.code === 'contribution-entries-rejected')).toBe(true);

      const cli = shrk(root, ['packs', 'doctor', '--json']);
      const cliBody = JSON.parse(cli.stdout) as { exitCode: number };
      expect(cli.status).toBe(1);
      expect(mcp.exitCode).toBe(cliBody.exitCode);

      expect(shrk(root, ['check', 'packs']).status).toBe(cli.status);

      const quality = JSON.parse(shrk(root, ['quality', '--json']).stdout) as { items: { id: string; status: string }[] };
      expect(quality.items.find((i) => i.id === 'packs')?.status).toBe('failed');
    },
    TIMEOUT_MS,
  );

  test('grep lock: no source outside pack-doctor.ts calls the sync `buildPackDoctorReport(` — every surface runs the async doctor', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === '__tests__' || name === 'node_modules' || name === 'dist') continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.ts') && name !== 'pack-doctor.ts') {
          // A CALL, not a prose citation (a backtick-quoted name in a changelog or doc comment).
          if (/(?<![`'"])\bbuildPackDoctorReport\s*\(/.test(readFileSync(full, 'utf8'))) offenders.push(relative(REPO_ROOT, full));
        }
      }
    };
    const packages = join(REPO_ROOT, 'packages');
    for (const pkg of readdirSync(packages)) {
      const src = join(packages, pkg, 'src');
      try {
        if (statSync(src).isDirectory()) walk(src);
      } catch {
        // a package without src/ has no source to lock
      }
    }
    expect(offenders).toEqual([]);
  });
});
