/**
 * r75 — round 11 docs review: the exits the docs promise, reproduced through
 * the real dispatcher (`runCli`, in-process, real `buildRegistry()`) over
 * mkdtemp fixtures loaded by the real config loader.
 *
 *   DOC-2  a surface refusal under `--json` (or `--format json`) prints the
 *          documented body — `sharkcraft.surface.not-enabled.v1` with its
 *          `reasonCode` — on stdout, for all three reason codes. The gate
 *          printed the text alone, so an agent branching on `reasonCode` read
 *          zero bytes.
 *   DOC-3  `registrations doctor`, `scaffolds doctor` and `search tuning
 *          doctor` over nothing declared are NOT VERIFIED (2) — the answer the
 *          helper / checks / conventions / templates doctors give — and
 *          `--allow-empty` accepts it (0, printed). They exited 0 over nothing.
 *   DOC-5  a config that does not load (or no `sharkcraft/` folder) is a usage
 *          error (3) on every verdict verb whose rules live in it. `check
 *          wiring`, `registry <name> …` and `wiring unprovided|orphans|chain`
 *          returned 1, which a CI step reads as "violations found".
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from '../command-registry.ts';
import { ExitCode, isGateVerb, resetPipeHintLatch } from '../exit-codes.ts';
import { runCli } from '../main.ts';
import { setActiveCommandRegistry } from '../surface/command-index.ts';
import {
  SURFACE_NOT_ENABLED_EXIT_CODE,
  SURFACE_NOT_ENABLED_SCHEMA,
  surfaceRefusalFor,
  surfaceRefusalOutput,
} from '../surface/not-enabled-error.ts';
import { SurfaceRefusalReason } from '../surface/surface-refusal-reason.ts';
import { TierSource } from '../surface/tier.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const TIMEOUT_MS = 240_000;

const roots: string[] = [];
afterAll(() => {
  setActiveCommandRegistry(undefined);
  // The in-process runs below end verdict verbs non-zero on a piped stdout,
  // which sets the process-lifetime pipe-hint latch: restore it, or a later
  // file in the same `bun test` process never sees its first note.
  resetPipeHintLatch();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function fixture(prefix: string, files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), `shrk-r75-docrev-${prefix}-`));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const PACKAGE_JSON = JSON.stringify({ name: 'consumer-app', version: '0.0.0' });

/** A consumer repo with a VALID config; `extra` is spliced into its object literal. */
function consumer(extra = ''): string {
  return fixture('consumer', {
    'package.json': PACKAGE_JSON,
    'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'consumer-app',${extra} };\n`,
    'src/index.ts': "export const hello = (): string => 'hi';\n",
  });
}

/** A config the loader rejects (an unknown key on a wiring rule). */
function badConfig(): string {
  return fixture('badcfg', {
    'package.json': PACKAGE_JSON,
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'x', wiringRules: [{ title: 'x' }] };\n",
  });
}

/** No `sharkcraft/` folder at all. */
function noSharkcraft(): string {
  return fixture('bare', { 'package.json': PACKAGE_JSON });
}

interface IRun {
  readonly code: number | 'timeout';
  readonly out: string;
  readonly err: string;
}

/** `runCli` in-process with stdout / stderr captured. */
async function runInProcess(argv: readonly string[], timeoutMs = 120_000): Promise<IRun> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = '';
  let err = '';
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array): boolean => {
    err += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await Promise.race([
      runCli(argv),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
    ]);
    return { code, out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

// ── DOC-2 ───────────────────────────────────────────────────────────────────

describe('DOC-2 — a surface refusal under --json is the documented body, on stdout', () => {
  test(
    'tool-maintenance: `docs check --json` in a consumer repo → 78, stdout is the refusal (reasonCode tool-maintenance), stderr empty',
    async () => {
      const r = await runInProcess(['--cwd', consumer(), 'docs', 'check', '--json']);
      expect(r.code).toBe(SURFACE_NOT_ENABLED_EXIT_CODE);
      expect(JSON.parse(r.out)).toMatchObject({
        schema: SURFACE_NOT_ENABLED_SCHEMA,
        command: 'docs check',
        reasonCode: SurfaceRefusalReason.ToolMaintenance,
      });
      expect(r.err).not.toContain('maintains SharkCraft itself');
    },
    TIMEOUT_MS,
  );

  test(
    "disabled: `surface.disabled: ['bundle *']` → `bundle list --json` is 78 with reasonCode disabled; without --json the text stays on stderr",
    async () => {
      const fx = consumer(" surface: { disabled: ['bundle *'] }");
      const json = await runInProcess(['--cwd', fx, 'bundle', 'list', '--json']);
      expect(json.code).toBe(SURFACE_NOT_ENABLED_EXIT_CODE);
      const body = JSON.parse(json.out) as { reasonCode: string; enableCommand: string };
      expect(body).toMatchObject({ schema: SURFACE_NOT_ENABLED_SCHEMA, reasonCode: SurfaceRefusalReason.Disabled });
      expect(body.enableCommand).toContain('surface allow');

      const text = await runInProcess(['--cwd', fx, 'bundle', 'list']);
      expect(text.code).toBe(SURFACE_NOT_ENABLED_EXIT_CODE);
      expect(text.out).toBe('');
      expect(text.err).toContain('is disabled in this repository by surface.disabled');
    },
    TIMEOUT_MS,
  );

  test('experimental (a pack-contributed command): the one writer prints reasonCode experimental under --json and --format json, the text otherwise', () => {
    const refusal = surfaceRefusalFor({
      command: 'acme deploy',
      source: TierSource.PackContribution,
      detail: 'pack-contributed (@acme/pack)',
    });
    expect(refusal.reasonCode).toBe(SurfaceRefusalReason.Experimental);
    for (const argv of [['--json'], ['--format', 'json']]) {
      const o = surfaceRefusalOutput(refusal, parseArgs(argv));
      expect(o.stderr).toBe('');
      expect(JSON.parse(o.stdout)).toMatchObject({
        schema: SURFACE_NOT_ENABLED_SCHEMA,
        command: 'acme deploy',
        reasonCode: SurfaceRefusalReason.Experimental,
      });
    }
    const text = surfaceRefusalOutput(refusal, parseArgs([]));
    expect(text.stdout).toBe('');
    expect(text.stderr).toContain('exists but is not enabled');
  });
});

// ── DOC-3 ───────────────────────────────────────────────────────────────────

const EMPTY_DOCTORS: readonly (readonly string[])[] = [
  ['registrations', 'doctor'],
  ['scaffolds', 'doctor'],
  ['search', 'tuning', 'doctor'],
];

describe('DOC-3 — the registrations / scaffolds / search tuning doctors over nothing declared', () => {
  for (const verb of EMPTY_DOCTORS) {
    const label = verb.join(' ');
    test(
      `${label}: nothing declared → 2 (text and --json); --allow-empty → 0 with the acceptance printed`,
      async () => {
        const fx = consumer();
        expect(isGateVerb(label)).toBe(true);

        const text = await runInProcess(['--cwd', fx, ...verb]);
        expect(text.code).toBe(ExitCode.NotVerified);
        expect(text.out).toContain('NOT VERIFIED');

        const json = await runInProcess(['--cwd', fx, ...verb, '--json']);
        expect(json.code).toBe(ExitCode.NotVerified);
        const body = JSON.parse(json.out) as { exitCode: number; shortfalls: string[] };
        expect(body.exitCode).toBe(ExitCode.NotVerified);
        expect(body.shortfalls.length).toBeGreaterThan(0);

        const accepted = await runInProcess(['--cwd', fx, ...verb, '--allow-empty']);
        expect(accepted.code).toBe(ExitCode.VerifiedPass);
        expect(accepted.out).toContain('accepted by --allow-empty');

        const acceptedJson = await runInProcess(['--cwd', fx, ...verb, '--allow-empty', '--json']);
        expect(acceptedJson.code).toBe(ExitCode.VerifiedPass);
        const acceptedBody = JSON.parse(acceptedJson.out) as { exitCode: number; accepted: string[] };
        expect(acceptedBody.exitCode).toBe(ExitCode.VerifiedPass);
        expect(acceptedBody.accepted.join('\n')).toContain('--allow-empty');
      },
      TIMEOUT_MS,
    );
  }

  test('exit-codes.md lists all three under the --allow-empty valve', () => {
    const doc = readFileSync(join(REPO_ROOT, 'docs/exit-codes.md'), 'utf8');
    const row = doc.split('\n').find((l) => l.startsWith('| `--allow-empty` |'));
    expect(row).toBeDefined();
    for (const verb of EMPTY_DOCTORS) expect(row).toContain(`\`${verb.join(' ')}\``);
  });
});

// ── DOC-5 ───────────────────────────────────────────────────────────────────

/** Every verdict verb whose rules / declarations live in sharkcraft.config.ts. */
const CONFIG_VERBS: readonly (readonly string[])[] = [
  ['check', 'wiring'],
  ['check', 'wiring', '--json'],
  ['registry', 'ghosts', 'list'],
  ['registry', 'ghosts', 'exists', 'foo', '--fail-if-taken'],
  ['registry', 'ghosts', 'where', 'foo'],
  ['registry', 'ghosts', 'duplicates', '--json'],
  ['wiring', 'unprovided'],
  ['wiring', 'orphans', '--json'],
  ['wiring', 'chain', 'tok'],
  ['policy-lint'],
  ['gates', 'check'],
  ['gates', 'coverage'],
  ['baseline', 'check'],
  ['generated', 'check'],
  ['docs', 'references', 'check'],
  ['reuse', 'coverage'],
];

describe('DOC-5 — an unloadable config is a usage error (3) on every config-reading verdict verb, never 1', () => {
  const cases: readonly (readonly [string, () => string])[] = [
    ['an invalid config', badConfig],
    ['no sharkcraft/ folder', noSharkcraft],
  ];
  for (const [label, make] of cases) {
    test(
      `${label}: each verb exits 3, and its --json carries exitCode 3`,
      async () => {
        const fx = make();
        const wrong: string[] = [];
        for (const argv of CONFIG_VERBS) {
          const verb = argv.filter((a) => !a.startsWith('-')).join(' ');
          expect({ verb, gate: isGateVerb(verb) }).toEqual({ verb, gate: true });
          const r = await runInProcess(['--cwd', fx, ...argv]);
          if (r.code !== ExitCode.UsageError) wrong.push(`${argv.join(' ')} → ${String(r.code)}`);
          if (argv.includes('--json') && r.code === ExitCode.UsageError) {
            const body = JSON.parse(r.out) as { exitCode?: number };
            if (body.exitCode !== ExitCode.UsageError) wrong.push(`${argv.join(' ')}: --json exitCode ${String(body.exitCode)}`);
          }
        }
        expect(wrong).toEqual([]);
      },
      TIMEOUT_MS,
    );
  }
});
