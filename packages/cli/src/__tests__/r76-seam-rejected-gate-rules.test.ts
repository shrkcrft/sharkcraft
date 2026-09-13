/**
 * r76 — a pack gate-plane rule the pack-plane merge seam REJECTS is a
 * configured rule that did not run (round 12 review, R12-X1 / R12-X3 /
 * R12-DOC-2). Spawned from source against real temp workspaces with a real
 * pack under node_modules.
 *
 * R12-X1: a pack policy rule with `files: ['!src/**\/*.ts']` (negation-only)
 * was rejected at the seam and then simply absent — `policy-lint`, `gates
 * check` and `gates coverage` printed a ✓ at exit 0 over it while `packs
 * contributions` / `packs doctor` exited 1 on the same tree. Every plane reader
 * now carries it as an ERRORED row (`failed validation — NOT evaluated`, exit
 * 1), exactly as the boundary plane reports a rejected boundary rule. A
 * `duplicate-id` collision (local wins) is NOT such a row: the id runs.
 *
 * R12-X3: a pack rule overriding a `$use` extractor with a negation-only
 * `files` (the schema's `$use` branch) — or whose MERGED shape is invalid (the
 * post-resolution check) — was adopted by the seam ("accepted", exit 0) while
 * `check wiring` called it misconfigured. It is now rejected on every surface.
 *
 * R12-DOC-2: a wiring source its own negations emptied is worded as such on
 * `check wiring` and `gates check`, never "0 files matched the source globs".
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const SPAWN_TIMEOUT_MS = 300_000;
const PACK = '@r76/seam';
const roots: string[] = [];

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

interface IRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function shrk(cwd: string, argv: readonly string[]): IRun {
  const res = spawnSync('bun', ['run', CLI_MAIN, '--no-hints', ...argv], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function json<T>(cwd: string, argv: readonly string[]): { readonly status: number; readonly body: T } {
  const r = shrk(cwd, argv);
  try {
    return { status: r.status, body: JSON.parse(r.stdout) as T };
  } catch {
    throw new Error(`\`shrk ${argv.join(' ')}\` did not print JSON (exit ${r.status}):\n${r.stdout.slice(0, 800)}\n${r.stderr.slice(0, 800)}`);
  }
}

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

const ts = (value: unknown): string => `export default ${JSON.stringify(value, null, 2)};\n`;

/** A real workspace: config + sources, and a real pack whose manifest contributes `packFiles`. */
function workspace(
  config: Record<string, unknown>,
  packFiles: Readonly<Record<string, { readonly slot: string; readonly body: unknown }>>,
  files: Readonly<Record<string, string>> = {},
): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r76-seam-'));
  roots.push(root);
  write(root, 'package.json', JSON.stringify({ name: 'fx', version: '0.0.0' }));
  write(root, 'sharkcraft/sharkcraft.config.ts', ts({ projectName: 'fx', ...config }));
  for (const [rel, body] of Object.entries(files)) write(root, rel, body);
  if (Object.keys(packFiles).length > 0) {
    const dir = `node_modules/${PACK}`;
    const contributions: Record<string, string[]> = {};
    for (const [file, { slot, body }] of Object.entries(packFiles)) {
      (contributions[slot] ??= []).push(`./${file}`);
      write(root, `${dir}/${file}`, ts(body));
    }
    write(root, `${dir}/package.json`, JSON.stringify({ name: PACK, version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }));
    write(
      root,
      `${dir}/manifest.json`,
      JSON.stringify({ schema: 'sharkcraft.pack/v1', info: { name: PACK, version: '0.0.1' }, contributions }),
    );
  }
  return root;
}

interface IGateRow {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly error?: string;
  readonly skipReason?: string;
}

const SOURCES = {
  'src/a.ts': 'export const A_HANDLER = 1; // TODO\n',
  'src/a.spec.ts': '// TODO in a spec\nexport const SPEC_HANDLER = 1;\n',
  'src/registry.ts': 'export const HANDLERS = [A_HANDLER];\n',
};

/** Negation-only lists and a bad enum, one per plane — each refused by the seam's schema. */
const REJECTED_PLANE_PACK = {
  'policy.ts': {
    slot: 'policyRuleFiles',
    body: [
      { id: 'pk-ok', surface: 'ts', files: ['src/**/*.ts'], pattern: 'NEVER_PRESENT_XYZ', message: 'm', severity: 'warning', failOnEmpty: false },
      { id: 'pk-todo-specs', surface: 'ts', files: ['!src/**/*.ts'], pattern: 'TODO', message: 'no todo', severity: 'error' },
      { id: 'pk-dup', surface: 'ts', files: ['src/**/*.ts'], pattern: 'NEVER_PRESENT_XYZ', message: 'm', severity: 'warning', failOnEmpty: false },
    ],
  },
  'registries.ts': {
    slot: 'registryFiles',
    body: [{ name: 'pk-reg', source: { files: ['!src/**/*.spec.ts'], extract: 'call-args', anchor: 'define' } }],
  },
  'wiring.ts': {
    slot: 'wiringRuleFiles',
    body: [
      {
        id: 'pk-w-bad',
        severity: 'fatal',
        declared: { files: ['src/a.ts'], extract: 'regex-capture', pattern: '(\\w+_HANDLER)' },
        registered: { files: ['src/registry.ts'], extract: 'regex-capture', pattern: '(\\w+_HANDLER)' },
      },
    ],
  },
  'baselines.ts': {
    slot: 'baselineFiles',
    body: [{ id: 'pk-b-bad', baseline: 'b.txt', compute: { kind: 'extractor', source: { files: ['!src/**'], extract: 'export-names' } } }],
  },
  'generated.ts': {
    slot: 'generatedArtifactFiles',
    body: [{ id: 'pk-g-bad', generatedGlob: ['!gen/**'], provenanceHeader: { mustMatch: 'GEN' } }],
  },
} as const;

const REJECTED_IDS = ['pk-b-bad', 'pk-g-bad', 'pk-reg', 'pk-todo-specs', 'pk-w-bad'];

describe('R12-X1 — a seam-rejected pack rule is an errored row on every plane reader', () => {
  // A local rule `pk-dup` collides with the pack's: local wins — a diagnostic, never an errored row.
  const root = workspace(
    {
      policyRules: [
        { id: 'pk-dup', surface: 'ts', files: ['src/**/*.ts'], pattern: 'NEVER_PRESENT_XYZ', message: 'm', severity: 'warning', failOnEmpty: false },
      ],
    },
    REJECTED_PLANE_PACK,
    SOURCES,
  );

  test(
    '`gates check`: every rejected rule is an errored row, the run exits 1, and no ✓ is printed',
    () => {
      const { status, body } = json<{ rejected: number; configured: number; gate: { exit: number; rules: IGateRow[] } }>(root, [
        'gates',
        'check',
        '--json',
      ]);
      expect(status).toBe(1);
      expect(body.gate.exit).toBe(1);
      expect(body.rejected).toBe(REJECTED_IDS.length);
      const errored = body.gate.rules.filter((r) => r.status === 'error').map((r) => r.id).sort();
      expect(errored).toEqual(REJECTED_IDS);
      for (const r of body.gate.rules.filter((x) => x.status === 'error')) {
        expect(r.error).toContain('failed validation at the pack-plane merge seam — NOT evaluated');
      }
      // The duplicate id is the LOCAL rule, and it ran.
      expect(body.gate.rules.filter((r) => r.id === 'pk-dup').map((r) => r.status)).toEqual(['passed']);
      expect(body.gate.rules.find((r) => r.id === 'pk-ok')?.status).toBe('passed');

      const text = shrk(root, ['gates', 'check']);
      expect(text.status).toBe(1);
      expect(text.stdout).toContain('failed validation at the pack-plane merge seam and never ran — FAILED');
      expect(text.stdout).not.toContain('Every declared rule ran and passed');
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    '`gates coverage`: each rejected rule is a misconfigured row — exit 1, not "Every rule is connected ✓"',
    () => {
      const { status, body } = json<{ errored: number; rules: IGateRow[]; gate: { exit: number } }>(root, ['gates', 'coverage', '--json']);
      expect(status).toBe(1);
      expect(body.gate.exit).toBe(1);
      expect(body.errored).toBe(REJECTED_IDS.length);
      expect(body.rules.filter((r) => r.status === 'error').map((r) => r.id).sort()).toEqual(REJECTED_IDS);
      const text = shrk(root, ['gates', 'coverage']);
      expect(text.stdout).not.toContain('Every rule is connected to something. ✓');
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    'the per-plane verdict verbs agree: policy-lint, check wiring, baseline check, generated check, registry — all exit 1',
    () => {
      const policy = json<{ rejected: { id: string }[]; gate: { exit: number } }>(root, ['policy-lint', '--json']);
      expect(policy.status).toBe(1);
      expect(policy.body.rejected.map((r) => r.id)).toEqual(['pk-todo-specs']);
      // `--only <rejected id>` selects its errored row — never "unknown id".
      expect(shrk(root, ['policy-lint', '--only', 'pk-todo-specs', '--json']).status).toBe(1);

      const wiring = json<{ rejected: { id: string }[] }>(root, ['check', 'wiring', '--json']);
      expect(wiring.status).toBe(1);
      expect(wiring.body.rejected.map((r) => r.id)).toEqual(['pk-w-bad']);
      expect(shrk(root, ['check', 'wiring', '--explain', 'pk-w-bad']).status).toBe(1);

      const baseline = json<{ rejected: { id: string }[] }>(root, ['baseline', 'check', '--json']);
      expect(baseline.status).toBe(1);
      expect(baseline.body.rejected.map((r) => r.id)).toEqual(['pk-b-bad']);

      const generated = json<{ rejected: { id: string }[] }>(root, ['generated', 'check', '--json']);
      expect(generated.status).toBe(1);
      expect(generated.body.rejected.map((r) => r.id)).toEqual(['pk-g-bad']);

      const registry = json<{ rejected: boolean; error: string; exitCode: number }>(root, ['registry', 'pk-reg', 'list', '--json']);
      expect(registry.status).toBe(1);
      expect(registry.body).toMatchObject({ rejected: true, exitCode: 1 });
      expect(registry.body.error).toContain('source.files');
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    'the list verbs name them (exit 0), and `packs contributions` fails the same tree',
    () => {
      const list = json<{ rejected: { id: string; plane: string }[] }>(root, ['gates', 'list', '--json']);
      expect(list.status).toBe(0);
      expect(list.body.rejected.map((r) => r.id).sort()).toEqual(REJECTED_IDS);
      expect(shrk(root, ['packs', 'contributions', '--json']).status).toBe(1);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    '`finish`: the policy / wiring sub-gates FAIL naming the rejected rules, whatever changed — never "Safe to finish"',
    () => {
      // A throwaway git repository INSIDE the temp workspace (the finish verb
      // scopes to the working-tree change) — the same setup finish-command.test uses.
      const git = (...args: string[]): void => {
        const res = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
        if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
      };
      git('init', '-q');
      git('-c', 'user.email=r76@example.invalid', '-c', 'user.name=r76', 'add', '-A');
      git('-c', 'user.email=r76@example.invalid', '-c', 'user.name=r76', 'commit', '-q', '-m', 'init');
      write(root, 'src/a.ts', 'export const A_HANDLER = 2; // TODO\n');
      const { status, body } = json<{
        verdict: string;
        gates: { name: string; status: string; items: { message: string }[] }[];
      }>(root, ['finish', '--json']);
      expect(status).toBe(1);
      expect(body.verdict).toBe('fail');
      const gate = (name: string) => body.gates.find((g) => g.name === name)!;
      expect(gate('policy').status).toBe('fail');
      expect(gate('policy').items.some((i) => i.message.startsWith('rejected pack rule pk-todo-specs:'))).toBe(true);
      expect(gate('wiring').status).toBe('fail');
      expect(gate('wiring').items.some((i) => i.message.startsWith('rejected pack rule pk-w-bad:'))).toBe(true);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    '`quality`: the rejected rule is a FAILED item and the coverage item fails — never a pass',
    () => {
      const { body } = json<{ exitCode: number; items: { id: string; status: string }[] }>(root, ['quality', '--json']);
      expect(body.exitCode).toBe(1);
      expect(body.items.find((i) => i.id === 'policy:pk-todo-specs')?.status).toBe('failed');
      expect(body.items.find((i) => i.id === 'gates-coverage')?.status).toBe('failed');
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe('R12-X3 — a `$use` pack source is judged on its merged shape, at the seam and in `gates try`', () => {
  const HANDLERS = { files: ['src/**/*.ts'], extract: 'export-names', match: '_HANDLER$' };
  const REGISTERED = { files: ['src/registry.ts'], extract: 'array-members', anchor: 'HANDLERS' };
  const root = workspace(
    { extractors: { handlers: HANDLERS } },
    {
      'wiring.ts': {
        slot: 'wiringRuleFiles',
        body: [
          // Caught by the schema's `$use` branch (a locally spelled list is judged standalone).
          { id: 'pk-use-negonly', severity: 'warning', declared: { $use: 'handlers', files: ['!src/**/*.spec.ts'] }, registered: REGISTERED },
          // Only the MERGED shape is wrong: `call-args` needs an anchor the extractor does not supply.
          { id: 'pk-use-merged', severity: 'warning', declared: { $use: 'handlers', extract: 'call-args' }, registered: REGISTERED },
        ],
      },
    },
    SOURCES,
  );

  test(
    '`packs contributions` rejects both (exit 1) — it said "1 of 1 declared entry accepted ✓"',
    () => {
      const { status, body } = json<{
        report: { files: { file: string; accepted: number; rejected: { entryId?: string; reasons: string[] }[] }[] };
      }>(root, ['packs', 'contributions', '--json']);
      expect(status).toBe(1);
      const row = body.report.files.find((f) => f.file === `node_modules/${PACK}/wiring.ts`)!;
      expect(row.accepted).toBe(0);
      const reasons = Object.fromEntries(row.rejected.map((r) => [r.entryId, r.reasons.join('; ')]));
      expect(reasons['pk-use-negonly']).toContain('`files` needs at least one inclusion glob');
      expect(reasons['pk-use-merged']).toContain('requires an `anchor`');
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    '`check wiring` and `gates coverage` fail them as rejected (exit 1) — never "misconfigured … probably stale"',
    () => {
      const wiring = json<{ rejected: { id: string }[] }>(root, ['check', 'wiring', '--json']);
      expect(wiring.status).toBe(1);
      expect(wiring.body.rejected.map((r) => r.id).sort()).toEqual(['pk-use-merged', 'pk-use-negonly']);
      const coverage = shrk(root, ['gates', 'coverage', '--json']);
      expect(coverage.status).toBe(1);
      expect(coverage.stdout).not.toContain('probably stale');
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    '`packs test --load` catches the locally spelled negation-only list on the pack side',
    () => {
      const { status, body } = json<{ issues: { code: string; message: string }[] }>(root, [
        'packs',
        'test',
        `node_modules/${PACK}`,
        '--load',
        '--json',
      ]);
      expect(status).toBe(1);
      expect(body.issues.some((i) => i.code === 'asset-entry-rejected' && i.message.includes('pk-use-negonly'))).toBe(true);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    '`gates try` refuses a candidate whose merged shape would fail config load (exit 3)',
    () => {
      write(root, 'try.json', JSON.stringify({ id: 'try-merged', declared: { $use: 'handlers', extract: 'call-args' }, registered: REGISTERED }));
      const { status, body } = json<{ valid: boolean; error: string }>(root, ['gates', 'try', '--rule-file', 'try.json', '--json']);
      expect(status).toBe(3);
      expect(body.valid).toBe(false);
      expect(body.error).toContain('requires an `anchor`');
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe('R12-DOC-2 — a wiring source emptied by its own negations says so', () => {
  const root = workspace(
    {
      wiringRules: [
        {
          id: 'all-excluded',
          severity: 'warning',
          declared: { files: ['src/handlers/*.spec.ts', '!src/**/*.spec.ts'], extract: 'regex-capture', pattern: 'export const (\\w+_HANDLER)' },
          registered: { files: ['src/registry.ts'], extract: 'regex-capture', pattern: '(\\w+_HANDLER)' },
        },
      ],
    },
    {},
    {
      'src/handlers/a.ts': 'export const A_HANDLER = 1;\n',
      'src/handlers/a.spec.ts': 'export const SPEC_HANDLER = 1;\n',
      'src/registry.ts': 'export const HANDLERS = [A_HANDLER];\n',
    },
  );

  test(
    '`check wiring` and `gates check` word the skip as its own negations — never "0 files matched", never "stale selectors"',
    () => {
      const wiring = json<{ skipped: { ruleId: string; reason: string }[] }>(root, ['check', 'wiring', '--json']);
      expect(wiring.status).toBe(2);
      expect(wiring.body.skipped[0]!.reason).toStartWith('matched nothing after its own negations: every file its inclusion globs select is excluded (');
      expect(wiring.body.skipped[0]!.reason).toContain('!src/**/*.spec.ts (1 file)');

      const text = shrk(root, ['check', 'wiring']);
      expect(text.status).toBe(2);
      expect(text.stdout).toContain('matched nothing after its own negations');
      expect(text.stdout).not.toContain('0 files matched the source globs');

      const gates = shrk(root, ['gates', 'check']);
      expect(gates.status).toBe(2);
      expect(gates.stdout).toContain('SKIPPED — matched nothing after its own negations');
      expect(gates.stdout).not.toContain('see which selectors are stale');
      expect(gates.stdout).not.toContain('0 files matched the source globs');
    },
    SPAWN_TIMEOUT_MS,
  );
});
