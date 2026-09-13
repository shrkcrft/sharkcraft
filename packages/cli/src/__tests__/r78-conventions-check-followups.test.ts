/**
 * r78 — round 15 follow-ups (L1): `conventions check` after review.
 *
 *  - F1: the internal `applicable conventions` record is RUN-level
 *    (`gate.runRecords`) — it was a pseudo-row in `gate.rules`, counted in
 *    `gate.evaluated` as if it were a convention that ran. The exit semantics
 *    hold: none applicable → 2 unless `--allow-empty`, the acceptance printed.
 *  - F2: a convention the loader REJECTED is an ERRORED row with its reasons —
 *    exit 1, local or from a pack (the seam-rejected gate-rule precedent,
 *    R12-X1); `--json` carries `rejected[]`. It vanished: check printed
 *    "ok — no violations." at 0 over it. A duplicate id is a note (the first
 *    declaration runs), never a row.
 *  - F8: `notApplicable[].severity` is a `ConventionSeverity` member.
 *  - F9: `--files` paths are realpath-normalized — a symlinked absolute path
 *    behaves like its target (it read `../link/src/a.ts`, which no `fileGlobs`
 *    selected, so the convention was silently not applicable at exit 0).
 *
 * Real workspaces (a real pack under the fixture's node_modules), the CLI
 * spawned from source.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConventionSeverity } from '@shrkcrft/plugin-api';
import { ExitCode } from '../exit-codes.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const T = 60_000;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

type IRaw = Record<string, unknown>;
const NO_TS = [{ id: 'no-ts', description: 'no .ts file', forbidMatch: '\\.ts$' }];
const NEVER = [{ id: 'never', description: 'never', forbidMatch: 'zzz-never' }];
const conv = (id: string, extra: IRaw = {}): IRaw => ({ id, title: id, kind: 'naming', severity: 'error', rules: NEVER, ...extra });
/** Applies everywhere and never hits. */
const ALWAYS = conv('c.always');
/** Not applicable in a plain TypeScript workspace (no turbo marker). */
const TURBO = conv('c.turbo', { appliesTo: { profileIds: ['has-turborepo'] }, rules: NO_TS });
/** The round-12 report's own shape: no `severity` — refused by the loader. */
const BAD = { id: 'c.bad', title: 'c.bad', kind: 'naming', rules: [] };

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** A TypeScript workspace with `conventions` in sharkcraft/conventions.ts (omitted when undefined). */
function workspace(conventions: readonly IRaw[] | undefined, files: Record<string, string> = {}): string {
  const root = tmp('shrk-r78-conv-followups-');
  const all: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'tsconfig.json': '{}',
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
    'src/a.ts': 'export const a = 1;\n',
    ...(conventions ? { 'sharkcraft/conventions.ts': `export default ${JSON.stringify(conventions, null, 2)};\n` } : {}),
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) write(root, rel, body);
  return root;
}

/** A real pack under the fixture's node_modules contributing `conventions` (the r76 census layout). */
function withPack(root: string, name: string, conventions: readonly IRaw[]): void {
  const dir = join(root, 'node_modules', name);
  write(dir, 'package.json', JSON.stringify({ name, version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }));
  write(
    dir,
    'manifest.json',
    JSON.stringify({ schema: 'sharkcraft.pack/v1', info: { name, version: '0.0.1' }, contributions: { conventionFiles: ['./conventions.ts'] } }),
  );
  write(dir, 'conventions.ts', `export default ${JSON.stringify(conventions, null, 2)};\n`);
}

function shrk(cwd: string, argv: readonly string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('bun', ['--no-install', CLI_MAIN, '--no-hints', ...argv], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

interface ICoverage {
  readonly unit: string;
  readonly expected: number;
  readonly examined: number;
  readonly acceptedBy?: string;
}
interface IRow {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly severity: string;
  readonly error?: string;
  readonly coverage: ICoverage;
}
interface IRejected {
  readonly entryId?: string;
  readonly file: string;
  readonly index: number;
  readonly packageName?: string;
  readonly cause: string;
  readonly reasons: readonly string[];
}
interface ICheckJson {
  readonly hits: readonly { conventionId: string; file: string }[];
  readonly notApplicable: readonly { conventionId: string; severity: string }[];
  readonly rejected: readonly IRejected[];
  readonly applicable: number;
  readonly verdict: string;
  readonly exitCode: number;
  readonly gate: {
    readonly exit: number;
    readonly evaluated: number;
    readonly skipped: number;
    readonly failed: number;
    readonly accepted: readonly string[];
    readonly shortfalls: readonly string[];
    readonly coverage: ICoverage;
    readonly runRecords?: readonly ICoverage[];
    readonly rules: readonly IRow[];
  };
}

function check(cwd: string, files: string, extra: readonly string[] = []): { status: number; body: ICheckJson } {
  const r = shrk(cwd, ['conventions', 'check', '--files', files, '--json', ...extra]);
  try {
    return { status: r.status, body: JSON.parse(r.stdout) as ICheckJson };
  } catch {
    throw new Error(`did not print JSON (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
  }
}

const hitsOf = (b: ICheckJson): string[] => b.hits.map((h) => `${h.conventionId}:${h.file}`).sort();
const ran = (b: ICheckJson): number => b.gate.rules.filter((r) => r.status !== 'skipped' && r.status !== 'error').length;

describe('F1 — "applicable conventions" is a RUN-level record, never a row counted in evaluated', () => {
  test(
    'one passing + one not-applicable convention: no pseudo-row, evaluated = the rows that ran, the record rides in gate.runRecords; exit 0',
    () => {
      const root = workspace([TURBO, ALWAYS]);
      const { status, body } = check(root, 'src/a.ts');
      expect(status).toBe(ExitCode.VerifiedPass);
      expect(body.gate.rules.map((r) => r.id)).not.toContain('applicable conventions');
      expect(body.gate.rules.filter((r) => r.type === 'convention' && r.coverage.unit === 'applicable conventions')).toEqual([]);
      expect(body.gate.evaluated).toBe(ran(body));
      expect(body.gate.runRecords).toEqual([
        expect.objectContaining({ unit: 'applicable conventions', expected: 1, examined: 1 }),
      ]);
      // The files record stays THE run coverage.
      expect(body.gate.coverage).toEqual(expect.objectContaining({ unit: 'files', expected: 1, examined: 1 }));
      expect(body.applicable).toBe(1);
      // Adding a second applicable convention adds exactly one evaluated row.
      const two = check(workspace([TURBO, ALWAYS, conv('c.also')]), 'src/a.ts').body;
      expect(two.gate.evaluated).toBe(body.gate.evaluated + 1);
      expect(two.gate.runRecords).toEqual([expect.objectContaining({ expected: 2, examined: 2 })]);
    },
    T,
  );

  test(
    'every convention not applicable → 2 NOT VERIFIED from the run record (text + JSON); --allow-empty accepts it, printed',
    () => {
      const root = workspace([TURBO]);
      const text = shrk(root, ['conventions', 'check', '--files', 'src/a.ts']);
      expect(text.status).toBe(ExitCode.NotVerified);
      expect(text.stdout).toContain('NOT VERIFIED: 0 applicable conventions to examine');
      expect(text.stdout).toContain('every loaded convention is not applicable here');
      expect(text.stdout).toContain('Pass --allow-empty to accept, explicitly, that no convention applies here.');

      const { status, body } = check(root, 'src/a.ts');
      expect(status).toBe(ExitCode.NotVerified);
      expect(body.verdict).toBe('not-verified');
      expect(body.gate.rules.map((r) => r.id)).toEqual(['convention files', 'c.turbo']);
      expect(body.gate.shortfalls.some((s) => s.startsWith('0 applicable conventions to examine'))).toBe(true);

      const accepted = shrk(root, ['conventions', 'check', '--files', 'src/a.ts', '--allow-empty']);
      expect(accepted.status).toBe(ExitCode.VerifiedPass);
      expect(accepted.stdout).toContain('accepted by --allow-empty: 0 applicable conventions to examine');
      expect(accepted.stdout).toContain('accepted by appliesTo');
      const acceptedJson = check(root, 'src/a.ts', ['--allow-empty']).body;
      expect(acceptedJson.gate.runRecords).toEqual([expect.objectContaining({ expected: 0, acceptedBy: '--allow-empty' })]);
      expect(acceptedJson.gate.accepted.some((a) => a.startsWith('accepted by --allow-empty: 0 applicable conventions'))).toBe(true);
    },
    T,
  );

  test(
    'no convention loaded → no run record at all (the empty-registry case stays the convention-files record)',
    () => {
      const { status, body } = check(workspace(undefined), 'src/a.ts');
      expect(status).toBe(ExitCode.NotVerified);
      expect('runRecords' in body.gate).toBe(false);
    },
    T,
  );
});

describe('F2 — a convention the loader rejected is an ERRORED row (exit 1), never a silent drop', () => {
  test(
    'local: the rejected convention is an error row with its reasons; the valid one still runs; --json rejected[]; exit 1 in text and JSON',
    () => {
      const root = workspace([ALWAYS, BAD]);
      const text = shrk(root, ['conventions', 'check', '--files', 'src/a.ts']);
      expect(text.status).toBe(ExitCode.Failure);
      expect(text.stdout).not.toContain('ok — no violations');
      expect(text.stdout).toContain('1 rejected');
      expect(text.stdout).toMatch(/error {3}convention rejected at load — NOT evaluated: 'c\.bad' \(.*\[1\]\) — severity: .*\(sharkcraft\/conventions\.ts\)/);
      expect(text.stdout).toContain('shrk conventions doctor');

      const { status, body } = check(root, 'src/a.ts');
      expect(status).toBe(ExitCode.Failure);
      expect(body.exitCode).toBe(ExitCode.Failure);
      expect(body.verdict).toBe('has-violations');
      expect(body.rejected).toEqual([
        expect.objectContaining({ entryId: 'c.bad', file: 'sharkcraft/conventions.ts', index: 1, cause: 'invalid' }),
      ]);
      expect(body.rejected[0]!.reasons.some((r) => r.startsWith('severity:'))).toBe(true);
      expect('packageName' in body.rejected[0]!).toBe(false);
      const row = body.gate.rules.find((r) => r.id === 'c.bad')!;
      expect(row).toEqual(
        expect.objectContaining({ type: 'convention', status: 'error', severity: 'error' }),
      );
      expect(row.error).toContain('NOT evaluated');
      expect(row.coverage).toEqual(expect.objectContaining({ unit: 'conventions', expected: 1, examined: 0 }));
      expect(body.gate.failed).toBe(1);
      // The accepted convention ran; the rejected one is never evaluated.
      expect(body.gate.rules.find((r) => r.id === 'c.always')!.status).toBe('passed');
      expect(body.gate.evaluated).toBe(ran(body));
    },
    T,
  );

  test(
    'from a pack under node_modules: the row names the pack; rejected[].packageName is set',
    () => {
      const root = workspace(undefined);
      withPack(root, '@r78/conv-pack', [conv('p.ok'), { ...BAD, id: 'p.bad' }]);
      const text = shrk(root, ['conventions', 'check', '--files', 'src/a.ts']);
      expect(text.status).toBe(ExitCode.Failure);
      expect(text.stdout).toContain("pack @r78/conv-pack convention rejected at load — NOT evaluated: 'p.bad'");

      const { status, body } = check(root, 'src/a.ts');
      expect(status).toBe(ExitCode.Failure);
      expect(body.rejected).toEqual([expect.objectContaining({ entryId: 'p.bad', packageName: '@r78/conv-pack', cause: 'invalid' })]);
      expect(body.gate.rules.find((r) => r.id === 'p.bad')!.status).toBe('error');
      expect(body.gate.rules.find((r) => r.id === 'p.ok')!.status).toBe('passed');
    },
    T,
  );

  test(
    'one row per refused DECLARATION: a local and a pack invalid `c.bad` are two rows (the count matches rejected[]), ids unique',
    () => {
      const root = workspace([ALWAYS, BAD]);
      withPack(root, '@r78/conv-pack', [{ ...BAD }]);
      const text = shrk(root, ['conventions', 'check', '--files', 'src/a.ts']);
      expect(text.status).toBe(ExitCode.Failure);
      expect(text.stdout).toContain('2 rejected');
      expect(text.stdout).toContain("pack @r78/conv-pack convention rejected at load — NOT evaluated: 'c.bad' (default[0])");
      expect(text.stdout).toContain("error   convention rejected at load — NOT evaluated: 'c.bad' (default[1])");
      expect(text.stdout).toContain('2 convention(s) rejected at load were NOT evaluated');

      const { status, body } = check(root, 'src/a.ts');
      expect(status).toBe(ExitCode.Failure);
      const invalid = body.rejected.filter((r) => r.cause === 'invalid');
      expect(invalid.map((r) => r.file).sort()).toEqual(['node_modules/@r78/conv-pack/conventions.ts', 'sharkcraft/conventions.ts']);
      const errored = body.gate.rules.filter((r) => r.status === 'error');
      // Every refused declaration is a row — keyed by the id, the second one vanished.
      expect(errored.length).toBe(invalid.length);
      expect(body.gate.failed).toBe(invalid.length);
      const ids = body.gate.rules.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(errored.map((r) => r.id).sort()).toEqual(['c.bad', 'c.bad (sharkcraft/conventions.ts[1])']);
    },
    T,
  );

  test(
    'a refused id a LOADED convention holds is qualified by its declaration site — the shortfall never names the convention that ran',
    () => {
      const root = workspace([conv('c.x')]);
      withPack(root, '@r78/conv-pack', [{ ...BAD, id: 'c.x' }]);
      const { status, body } = check(root, 'src/a.ts');
      expect(status).toBe(ExitCode.Failure);
      expect(body.rejected).toEqual([expect.objectContaining({ entryId: 'c.x', packageName: '@r78/conv-pack', cause: 'invalid' })]);
      const ids = body.gate.rules.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(body.gate.rules.find((r) => r.id === 'c.x')!.status).toBe('passed');
      const qualified = 'c.x (node_modules/@r78/conv-pack/conventions.ts[0])';
      expect(body.gate.rules.find((r) => r.id === qualified)!.status).toBe('error');
      expect(body.gate.shortfalls.some((s) => s.startsWith('c.x:'))).toBe(false);
      expect(body.gate.shortfalls.some((s) => s.startsWith(`${qualified}:`))).toBe(true);
    },
    T,
  );

  test(
    'a duplicate id is a printed note and a rejected[] record — not a row: the first declaration runs (exit 0)',
    () => {
      const root = workspace([ALWAYS, conv('c.always', { title: 'second' })]);
      const text = shrk(root, ['conventions', 'check', '--files', 'src/a.ts']);
      expect(text.status).toBe(ExitCode.VerifiedPass);
      expect(text.stdout).toContain(
        "note    'c.always' (default[1]) — id: \"c.always\" is already declared in sharkcraft/conventions.ts — this declaration is not evaluated; the first one runs (sharkcraft/conventions.ts)",
      );
      expect(text.stdout).toContain('ok — no violations.');
      const { body } = check(root, 'src/a.ts');
      expect(body.rejected).toEqual([expect.objectContaining({ entryId: 'c.always', index: 1, cause: 'duplicate-id' })]);
      expect(body.gate.rules.filter((r) => r.status === 'error')).toEqual([]);
    },
    T,
  );
});

describe('F8 — notApplicable[].severity is a ConventionSeverity member', () => {
  test(
    'each severity round-trips through the enum',
    () => {
      const severities = Object.values(ConventionSeverity);
      const root = workspace(severities.map((s) => conv(`c.turbo-${s}`, { severity: s, appliesTo: { profileIds: ['has-turborepo'] } })).concat([ALWAYS]));
      const { body } = check(root, 'src/a.ts');
      expect(body.notApplicable.map((n) => n.severity).sort()).toEqual([...severities].sort());
    },
    T,
  );
});

describe('F9 — --files paths are realpath-normalized', () => {
  test(
    'a symlinked absolute path behaves exactly like its target (hits, not-applicable, exit)',
    () => {
      const root = workspace([conv('c.src', { appliesTo: { fileGlobs: ['src/**'] }, rules: NO_TS }), TURBO, ALWAYS]);
      const link = join(tmp('shrk-r78-conv-link-'), 'link');
      symlinkSync(root, link, 'dir');
      const target = check(root, 'src/a.ts');
      expect(target.status).toBe(ExitCode.Failure);
      expect(hitsOf(target.body)).toEqual(['c.src:src/a.ts']);
      for (const spelling of [join(link, 'src/a.ts'), join(realpathSync(root), 'src/a.ts'), join(root, 'src/a.ts')]) {
        const r = check(root, spelling);
        expect({ spelling, status: r.status, hits: hitsOf(r.body), na: r.body.notApplicable.map((n) => n.conventionId) }).toEqual({
          spelling,
          status: target.status,
          hits: hitsOf(target.body),
          na: target.body.notApplicable.map((n) => n.conventionId),
        });
      }
    },
    T,
  );

  test(
    '--cwd through a symlink: an absolute path under the real root still reads project-relative',
    () => {
      const root = workspace([conv('c.src', { appliesTo: { fileGlobs: ['src/**'] }, rules: NO_TS })]);
      const link = join(tmp('shrk-r78-conv-cwdlink-'), 'link');
      symlinkSync(root, link, 'dir');
      const r = shrk(REPO_ROOT, ['--cwd', link, 'conventions', 'check', '--files', join(realpathSync(root), 'src/a.ts'), '--json']);
      const body = JSON.parse(r.stdout) as ICheckJson;
      expect({ status: r.status, hits: hitsOf(body) }).toEqual({ status: ExitCode.Failure, hits: ['c.src:src/a.ts'] });
    },
    T,
  );

  test(
    'an in-project symlinked directory reads as its target; a symlink leaving the project keeps its in-project spelling',
    () => {
      const outside = tmp('shrk-r78-conv-outside-');
      write(outside, 'x.ts', 'export const x = 1;\n');
      const root = workspace([
        conv('c.src', { appliesTo: { fileGlobs: ['src/**'] }, rules: NO_TS }),
        conv('c.ext', { appliesTo: { fileGlobs: ['ext/**'] }, rules: NO_TS }),
      ]);
      symlinkSync('src', join(root, 'srclink'), 'dir');
      symlinkSync(outside, join(root, 'ext'), 'dir');
      const viaLink = check(root, 'srclink/a.ts');
      expect(hitsOf(viaLink.body)).toEqual(['c.src:src/a.ts']);
      const leaving = check(root, 'ext/x.ts');
      expect(hitsOf(leaving.body)).toEqual(['c.ext:ext/x.ts']);
    },
    T,
  );
});
