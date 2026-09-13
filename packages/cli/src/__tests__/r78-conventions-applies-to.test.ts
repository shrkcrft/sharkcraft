/**
 * r78 — round 15 (15.1): `conventions check` honours every `appliesTo` filter.
 *
 * The report: one convention, `profileIds: ['has-turborepo']` (a builtin
 * profile NOT detected), `['<not a profile>']`, or no field — 178 hits each
 * time. Only `fileGlobs` scoped, through a private matcher that missed
 * `src/a.ts` under `src/**\/*.ts` and ignored `!`. Now THE applicability
 * authority (`conventionApplicability`) decides: a convention that does not
 * apply is never evaluated, always printed with its reason (`--json`
 * `notApplicable[]`), and accepted explicitly (`acceptedBy: 'appliesTo'`) so a
 * clean exit over it is honest; when none applies the run is 2 NOT VERIFIED
 * unless `--allow-empty`.
 *
 * Real workspaces, the CLI spawned from source.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ExitCode } from '../exit-codes.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const T = 60_000;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

interface IConv {
  readonly id: string;
  readonly appliesTo?: Record<string, readonly string[]>;
  readonly rules: readonly Record<string, string>[];
  readonly references?: readonly { kind: string; value: string }[];
  readonly tags?: readonly string[];
}

const conv = (c: IConv): Record<string, unknown> => ({ title: c.id, kind: 'naming', severity: 'error', ...c });
/** Hits every covered file whose path contains `zzz-never` — i.e. none: a convention that applies and passes. */
const ALWAYS: IConv = { id: 'c.always', rules: [{ id: 'never', description: 'never', forbidMatch: 'zzz-never' }] };
const NO_TS = [{ id: 'no-ts', description: 'no .ts file', forbidMatch: '\\.ts$' }];

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

/** A TypeScript workspace (tsconfig → `has-typescript` detected) with `conventions` in sharkcraft/conventions.ts. */
function workspace(conventions: readonly IConv[], opts: { pkg?: Record<string, unknown>; files?: Record<string, string> } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r78-conventions-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0', ...(opts.pkg ?? {}) }),
    'tsconfig.json': '{}',
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
    'sharkcraft/conventions.ts': `export default ${JSON.stringify(conventions.map(conv), null, 2)};\n`,
    'src/a.ts': 'export const a = 1;\n',
    ...(opts.files ?? {}),
  };
  for (const [rel, body] of Object.entries(files)) write(root, rel, body);
  return root;
}

function shrk(cwd: string, argv: readonly string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('bun', ['run', CLI_MAIN, '--no-hints', ...argv], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

interface IReason {
  readonly filter: string;
  readonly declared: readonly string[];
  readonly matched: boolean;
  readonly message: string;
}
interface ICheckJson {
  readonly hits: readonly { conventionId: string; file: string; message: string }[];
  readonly notApplicable: readonly { conventionId: string; reasons: readonly IReason[] }[];
  readonly applicable: number;
  readonly verdict: string;
  readonly exitCode: number;
  readonly gate: {
    exit: number;
    evaluated: number;
    skipped: number;
    accepted: readonly string[];
    shortfalls: readonly string[];
    rules: readonly { id: string; status: string; skipReason?: string; coverage: { acceptedBy?: string } }[];
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

describe('profileIds scopes (the report\'s regression lock)', () => {
  test(
    'an undetected builtin profile → 0 hits and a printed not-applicable line, exit 0 beside a passing convention; detected (turbo.json) → its normal hits',
    () => {
      const turbo: IConv = { id: 'c.turbo', appliesTo: { profileIds: ['has-turborepo'] }, rules: NO_TS };
      const root = workspace([turbo, ALWAYS]);

      const text = shrk(root, ['conventions', 'check', '--files', 'src/a.ts']);
      expect(text.status).toBe(ExitCode.VerifiedPass);
      expect(text.stdout).toContain(
        'n/a     c.turbo — not applicable: appliesTo.profileIds [has-turborepo]: none detected (detected: has-typescript)',
      );
      expect(text.stdout).not.toContain('c.turbo/no-ts');
      expect(text.stdout).toContain('accepted by appliesTo');

      const { status, body } = check(root, 'src/a.ts');
      expect(status).toBe(ExitCode.VerifiedPass);
      expect(body.hits).toEqual([]);
      expect(body.notApplicable.map((n) => n.conventionId)).toEqual(['c.turbo']);
      expect(body.notApplicable[0]!.reasons.map((r) => [r.filter, r.declared, r.matched])).toEqual([
        ['profileIds', ['has-turborepo'], false],
      ]);
      expect(body.applicable).toBe(1);
      // Never evaluated: its row is an accepted skip, outside `evaluated`.
      const row = body.gate.rules.find((r) => r.id === 'c.turbo')!;
      expect(row.status).toBe('skipped');
      expect(row.coverage.acceptedBy).toBe('appliesTo');
      expect(row.skipReason).toContain('not applicable');
      expect(body.gate.skipped).toBe(1);
      expect(body.gate.evaluated).toBe(body.gate.rules.filter((r) => r.status !== 'skipped').length);
      expect(body.gate.accepted.some((a) => a.startsWith('c.turbo: accepted by appliesTo'))).toBe(true);

      // The same convention with the profile DETECTED — through a root turbo.json
      // (no `turbo` dependency), a marker the detector could never see before.
      write(root, 'turbo.json', '{}');
      const detected = check(root, 'src/a.ts');
      expect(detected.status).toBe(ExitCode.Failure);
      expect(hitsOf(detected.body)).toEqual(['c.turbo:src/a.ts']);
      expect(detected.body.notApplicable).toEqual([]);
      expect(detected.body.gate.evaluated).toBe(body.gate.evaluated + 1);
    },
    T,
  );

  test(
    'every convention not applicable → 2 NOT VERIFIED (nothing checked the files); --allow-empty accepts it, printed',
    () => {
      const root = workspace([{ id: 'c.turbo', appliesTo: { profileIds: ['has-turborepo'] }, rules: NO_TS }]);
      const text = shrk(root, ['conventions', 'check', '--files', 'src/a.ts']);
      expect(text.status).toBe(ExitCode.NotVerified);
      expect(text.stdout).toContain('n/a     c.turbo');
      expect(text.stdout).toContain('NOT VERIFIED');
      expect(text.stdout).toContain('every loaded convention is not applicable here');
      expect(text.stdout).toContain('Pass --allow-empty');
      expect(check(root, 'src/a.ts').body.verdict).toBe('not-verified');

      const accepted = shrk(root, ['conventions', 'check', '--files', 'src/a.ts', '--allow-empty']);
      expect(accepted.status).toBe(ExitCode.VerifiedPass);
      expect(accepted.stdout).toContain('accepted by --allow-empty');
      expect(accepted.stdout).toContain('accepted by appliesTo');
    },
    T,
  );
});

describe('frameworks and languages scope too', () => {
  test(
    'frameworks: an undetected framework → not applicable; the framework detected (react dependency) → its hits',
    () => {
      const react: IConv = { id: 'c.react', appliesTo: { frameworks: ['react'] }, rules: NO_TS };
      const without = check(workspace([react, ALWAYS]), 'src/a.ts');
      expect(without.status).toBe(ExitCode.VerifiedPass);
      expect(without.body.hits).toEqual([]);
      expect(without.body.notApplicable[0]!.reasons[0]!.message).toContain('appliesTo.frameworks [react]: none detected');

      const withReact = check(workspace([react, ALWAYS], { pkg: { dependencies: { react: '*' } } }), 'src/a.ts');
      expect(withReact.status).toBe(ExitCode.Failure);
      expect(hitsOf(withReact.body)).toEqual(['c.react:src/a.ts']);
    },
    T,
  );

  test(
    'languages (per file): no file in scope of the language → not applicable; a file of it → its hits',
    () => {
      const py: IConv = { id: 'c.py', appliesTo: { languages: ['python'] }, rules: [{ id: 'no-bad', description: 'no bad', forbidMatch: 'bad' }] };
      const root = workspace([py, ALWAYS], { files: { 'src/bad.ts': 'x\n', 'src/bad.py': 'x\n' } });
      const ts = check(root, 'src/bad.ts');
      expect(ts.status).toBe(ExitCode.VerifiedPass);
      expect(ts.body.hits).toEqual([]);
      expect(ts.body.notApplicable[0]!.reasons[0]!.message).toContain('0 of 1 file(s) in scope are a listed language (seen: typescript)');

      const pyFile = check(root, 'src/bad.py,src/bad.ts');
      expect(pyFile.status).toBe(ExitCode.Failure);
      expect(hitsOf(pyFile.body)).toEqual(['c.py:src/bad.py']);
    },
    T,
  );
});

describe('fileGlobs through the boundaries matcher', () => {
  test(
    '`src/**/*.ts` matches the direct child src/a.ts (not root.ts); a `!` entry subtracts',
    () => {
      const root = workspace([
        { id: 'c.glob', appliesTo: { fileGlobs: ['src/**/*.ts'] }, rules: NO_TS },
        { id: 'c.neg', appliesTo: { fileGlobs: ['src/**', '!src/b.ts'] }, rules: NO_TS },
      ]);
      const r = check(root, 'src/a.ts,src/b.ts,src/deep/d.ts,root.ts');
      expect(r.status).toBe(ExitCode.Failure);
      expect(hitsOf(r.body)).toEqual([
        'c.glob:src/a.ts',
        'c.glob:src/b.ts',
        'c.glob:src/deep/d.ts',
        'c.neg:src/a.ts',
        'c.neg:src/deep/d.ts',
      ]);
    },
    T,
  );
});

describe('one spelling per file (round 15 review)', () => {
  test(
    '`--files ./src/a.ts` / an absolute path: the scope and the rule patterns read the same project-relative path — no false filePattern hit, and the hit names src/a.ts',
    () => {
      const root = workspace([
        { id: 'c.src', appliesTo: { fileGlobs: ['src/**'] }, rules: [{ id: 'under-src', description: 'under src/', filePattern: '^src/' }] },
        { id: 'c.nots', appliesTo: { fileGlobs: ['src/**'] }, rules: NO_TS },
      ]);
      // The child's cwd is the realpath (macOS /var → /private/var), so is its projectRoot.
      for (const spelling of ['./src/a.ts', realpathSync(join(root, 'src/a.ts'))]) {
        const r = check(root, spelling);
        expect({ spelling, status: r.status, hits: hitsOf(r.body) }).toEqual({
          spelling,
          status: ExitCode.Failure,
          hits: ['c.nots:src/a.ts'],
        });
      }
    },
    T,
  );
});

describe('the load contract: reserved and unknown filters', () => {
  test(
    'constructKinds → the reserved warning (fails --strict); the convention applies regardless',
    () => {
      const root = workspace([{ id: 'c.ck', appliesTo: { constructKinds: ['component'] }, rules: NO_TS }]);
      const doctor = shrk(root, ['conventions', 'doctor', '--json']);
      expect(doctor.status).toBe(ExitCode.VerifiedPass);
      const issues = (JSON.parse(doctor.stdout) as { issues: { severity: string; code: string; message: string }[] }).issues;
      expect(issues).toEqual([
        expect.objectContaining({
          severity: 'warning',
          code: 'convention-shape',
          message: 'appliesTo.constructKinds: appliesTo.constructKinds is reserved and not evaluated — the convention applies regardless',
        }),
      ]);
      expect(shrk(root, ['conventions', 'doctor', '--strict']).status).toBe(ExitCode.Failure);
      expect(hitsOf(check(root, 'src/a.ts').body)).toEqual(['c.ck:src/a.ts']);
    },
    T,
  );

  test(
    'an unknown appliesTo key → the convention is rejected with a did-you-mean (it used to apply to every file)',
    () => {
      const root = workspace([{ id: 'c.typo', appliesTo: { fileGlob: ['lib/**'] }, rules: NO_TS }, ALWAYS]);
      const doctor = shrk(root, ['conventions', 'doctor', '--json']);
      expect(doctor.status).toBe(ExitCode.Failure);
      const issues = (JSON.parse(doctor.stdout) as { issues: { code: string; conventionId?: string; message: string }[] }).issues;
      const invalid = issues.filter((i) => i.code === 'invalid-convention');
      expect(invalid.map((i) => i.conventionId)).toEqual(['c.typo']);
      expect(invalid[0]!.message).toContain('did you mean "fileGlobs"?');
      // Refused, so never evaluated — not one hit on every file.
      expect(check(root, 'src/a.ts').body.hits).toEqual([]);
      expect(shrk(root, ['conventions', 'list']).stderr + shrk(root, ['conventions', 'list']).stdout).toContain('c.typo');
    },
    T,
  );
});

describe('expectMatch is evaluated', () => {
  test(
    'a file in scope that does not match expectMatch is a hit (it was validated and never evaluated)',
    () => {
      const root = workspace([{ id: 'c.expect', rules: [{ id: 'under-src', description: 'under src/', expectMatch: '^src/' }] }]);
      const miss = check(root, 'lib/x.ts');
      expect(miss.status).toBe(ExitCode.Failure);
      expect(miss.body.hits.map((h) => h.message)).toEqual([
        'File "lib/x.ts" does not match the expected pattern /^src// of convention "c.expect" rule "under-src": under src/',
      ]);
      expect(check(root, 'src/a.ts').status).toBe(ExitCode.VerifiedPass);
    },
    T,
  );
});

describe('list / get / explain show applicability and never hide an entry', () => {
  test(
    'explain prints appliesTo, the applicability verdict, references and tags; list keeps the not-applicable entry',
    () => {
      const root = workspace([
        {
          id: 'c.turbo',
          appliesTo: { profileIds: ['has-turborepo'], fileGlobs: ['src/**'] },
          rules: NO_TS,
          references: [{ kind: 'doc', value: 'docs/naming.md' }],
          tags: ['naming-tag'],
        },
      ]);
      const explain = shrk(root, ['conventions', 'explain', 'c.turbo']);
      expect(explain.status).toBe(0);
      expect(explain.stdout).toContain('appliesTo     profileIds [has-turborepo] · fileGlobs [src/**]');
      expect(explain.stdout).toContain('applicability NOT applicable here');
      expect(explain.stdout).toContain('✗ appliesTo.profileIds [has-turborepo]: none detected');
      expect(explain.stdout).toContain('• doc: docs/naming.md');
      expect(explain.stdout).toContain('tags          naming-tag');

      const list = shrk(root, ['conventions', 'list']);
      expect(list.stdout).toContain('c.turbo');
      expect(list.stdout).toContain('not applicable here — appliesTo.profileIds [has-turborepo]: none detected');
      const listed = JSON.parse(shrk(root, ['conventions', 'list', '--json']).stdout) as {
        convention: { id: string };
        applicability: { applicable: boolean };
      }[];
      expect(listed.map((e) => [e.convention.id, e.applicability.applicable])).toEqual([['c.turbo', false]]);
      const got = JSON.parse(shrk(root, ['conventions', 'get', 'c.turbo', '--json']).stdout) as {
        applicability: { applicable: boolean; reasons: IReason[] };
      };
      expect(got.applicability.reasons.map((r) => [r.filter, r.matched])).toEqual([
        ['profileIds', false],
        ['fileGlobs', true],
      ]);
    },
    T,
  );
});
