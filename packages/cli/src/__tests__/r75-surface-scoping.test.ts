/**
 * r75 — the surface scopes `--help`, the gate and the listing through ONE
 * authority (round 11 §5.1#3).
 *
 * The bug: `surface.hidden` and profiles reached `surface list` / `surface
 * explain` only. `--full-help` decided visibility from the catalog alone, so
 * `surface explain graph` printed `visible-in-help false` while `--full-help`
 * listed `graph` — two code paths answering one question. There was no deny
 * list and no group selector (small-app enumerated eleven `bundle …` rows).
 *
 * Now `--full-help` and the start screen RENDER the surface summary;
 * `surface.disabled` (exact paths or `<group> *`) denies commands through the
 * existing surface gate (exit 78); `surface deny` / `surface allow` manage it;
 * profiles may carry `disabled`, and an explicit config `enabled` overrides a
 * profile's deny but never a config deny.
 *
 * Everything runs through the real `runCli` (in-process — the entry the binary
 * calls) or the CLI spawned from source, with the real `buildRegistry()` and
 * the real config loader over mkdtemp fixtures. A write-then-read sequence is
 * spawned: one process per step, as a user runs it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ISurfaceConfig } from '@shrkcrft/config';
import { buildRegistry, runCli } from '../main.ts';
import { renderStartScreen } from '../commands/help.command.ts';
import { commandIndexFor, setActiveCommandRegistry } from '../surface/command-index.ts';
import { composeSurfaceConfig, loadSurfaceContext } from '../surface/load-surface-context.ts';
import type { ISurfaceProfile } from '../surface/profiles.ts';
import {
  buildSurfaceSummary,
  findCommandInSummary,
  type ISurfaceCommandView,
  type ISurfaceSummary,
} from '../surface/surface-summary.ts';
import { SurfaceLayer } from '../surface/surface-layer.ts';
import { matchesSurfaceSelector } from '../surface/surface-selector.ts';
import { SURFACE_NOT_ENABLED_EXIT_CODE } from '../surface/not-enabled-error.ts';
import { TierSource, type ITierResolverContext } from '../surface/tier.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const SPAWN_TIMEOUT_MS = 180_000;

const roots: string[] = [];
afterAll(() => {
  setActiveCommandRegistry(undefined);
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A consumer repo; `surface` is the TS literal of its `surface{}` block. */
function consumer(surface?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-scope-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'consumer-app', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts':
      `export default {\n  projectName: 'consumer-app',\n` +
      (surface ? `  surface: ${surface},\n` : '') +
      `};\n`,
    'src/index.ts': "export const hello = (): string => 'hi';\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

interface IRun {
  readonly code: number | 'timeout';
  readonly out: string;
  readonly err: string;
}

/** `runCli` in-process with stdout/stderr captured. */
async function runInProcess(argv: readonly string[], timeoutMs = 60_000): Promise<IRun> {
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

function shrk(cwd: string, argv: readonly string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('bun', [CLI_MAIN, ...argv], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, SHARKCRAFT_USAGE_DISABLED: '1' },
    timeout: 120_000,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function allViews(summary: ISurfaceSummary): ISurfaceCommandView[] {
  return [...summary.tiers.core, ...summary.tiers.extended, ...summary.tiers.experimental];
}

/** The summary `runCli` renders for `cwd`: the real context over the real registry's index. */
async function summaryFor(cwd: string): Promise<ISurfaceSummary> {
  const { context } = await loadSurfaceContext({ cwd });
  return buildSurfaceSummary(context, commandIndexFor(buildRegistry()));
}

/** A `--full-help` command line: two-space indent, the command, padding, ` — `. */
const LISTED_LINE = /^ {2}(\S.*?)\s+— /;
/** The `--all` annotation at the end of a line. */
const ANNOTATION = / {2}\((hidden(?:, gated(?:: [a-z-]+)?)?|gated(?:: [a-z-]+)?)\)$/;

function listedCommands(out: string): Set<string> {
  const set = new Set<string>();
  for (const line of out.split('\n')) {
    const m = LISTED_LINE.exec(line);
    if (m?.[1]) set.add(m[1].trim());
  }
  return set;
}

describe('one visibility authority — view.visibleInHelp ⇔ `--full-help` lists the command', () => {
  const cases: readonly (readonly [string, string | undefined])[] = [
    [
      "the repro: profile small-app + surface.hidden ['graph', 'stats', 'docs check']",
      "{ profile: 'small-app', hidden: ['graph', 'stats', 'docs check'] }",
    ],
    ['no surface{} block', undefined],
    ["group selectors: hidden ['check *'], disabled ['bundle *', 'impact']", "{ hidden: ['check *'], disabled: ['bundle *', 'impact'] }"],
  ];
  for (const [label, surface] of cases) {
    test(
      label,
      async () => {
        const fx = consumer(surface);
        const summary = await summaryFor(fx);
        const run = await runInProcess(['--cwd', fx, '--full-help']);
        expect(run.code).toBe(0);
        const listed = listedCommands(run.out);
        const views = allViews(summary);
        const disagreements = views
          .filter((v) => v.visibleInHelp !== listed.has(v.command))
          .map((v) => `${v.command}: visibleInHelp=${v.visibleInHelp} listed=${listed.has(v.command)}`);
        expect(disagreements).toEqual([]);
        // Nothing is listed that the summary does not know.
        expect([...listed].filter((c) => !views.some((v) => v.command === c))).toEqual([]);
        expect(listed.size).toBeGreaterThan(20);
      },
      SPAWN_TIMEOUT_MS,
    );
  }

  test(
    "in SharkCraft's own repository too",
    async () => {
      const summary = await summaryFor(REPO_ROOT);
      const run = await runInProcess(['--cwd', REPO_ROOT, '--full-help']);
      expect(run.code).toBe(0);
      const listed = listedCommands(run.out);
      expect(allViews(summary).filter((v) => v.visibleInHelp !== listed.has(v.command)).map((v) => v.command)).toEqual([]);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    'the repro: `surface explain graph` says hidden, `--full-help` agrees, and it stays callable (hidden ≠ disabled)',
    async () => {
      const fx = consumer("{ profile: 'small-app', hidden: ['graph'] }");
      const explain = await runInProcess(['--cwd', fx, 'surface', 'explain', 'graph']);
      expect(explain.code).toBe(0);
      expect(explain.out).toMatch(/visible-in-help\s+false/);
      const help = await runInProcess(['--cwd', fx, '--full-help']);
      expect(listedCommands(help.out).has('graph')).toBe(false);
      // small-app hides `bundle` — the profile reaches --help too.
      expect(listedCommands(help.out).has('bundle')).toBe(false);
      expect(findCommandInSummary(await summaryFor(fx), 'graph')?.callable).toBe(true);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    '`--full-help --all` lists every view, annotated `hidden` ⇔ !visibleInHelp and `gated` ⇔ !callable',
    async () => {
      const fx = consumer("{ hidden: ['graph'], disabled: ['bundle *'] }");
      const summary = await summaryFor(fx);
      const run = await runInProcess(['--cwd', fx, '--full-help', '--all']);
      expect(run.code).toBe(0);
      const annotations = new Map<string, string>();
      for (const line of run.out.split('\n')) {
        const m = LISTED_LINE.exec(line);
        if (!m?.[1]) continue;
        annotations.set(m[1].trim(), ANNOTATION.exec(line)?.[1] ?? '');
      }
      const wrong: string[] = [];
      for (const v of allViews(summary)) {
        const note = annotations.get(v.command);
        if (note === undefined) {
          wrong.push(`${v.command}: not listed`);
          continue;
        }
        if (note.startsWith('hidden') !== !v.visibleInHelp) wrong.push(`${v.command}: hidden note "${note}"`);
        if (note.includes('gated') !== !v.callable) wrong.push(`${v.command}: gated note "${note}"`);
      }
      expect(wrong).toEqual([]);
      expect(annotations.get('bundle list')).toBe('hidden, gated: disabled');
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a group selector hides the whole group: hidden ['check *'] hides every `check …` view, all still callable",
    async () => {
      const summary = await summaryFor(consumer("{ hidden: ['check *'] }"));
      const check = allViews(summary).filter((v) => matchesSurfaceSelector('check *', v.command));
      expect(check.length).toBeGreaterThan(3);
      for (const v of check) {
        expect({ command: v.command, hidden: v.hidden, callable: v.callable, visibleInHelp: v.visibleInHelp }).toEqual({
          command: v.command,
          hidden: true,
          callable: true,
          visibleInHelp: false,
        });
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe('surface.disabled — a deny list through the existing gate (exit 78)', () => {
  test(
    "disabled ['bundle *'] gates every bundle command, and the listing says why",
    async () => {
      const fx = consumer("{ disabled: ['bundle *'] }");
      const run = await runInProcess(['--cwd', fx, 'bundle', 'list']);
      expect(run.code).toBe(SURFACE_NOT_ENABLED_EXIT_CODE);
      expect(run.out).toBe('');
      expect(run.err).toContain("`bundle list` is disabled in this repository by surface.disabled ('bundle *')");
      expect(run.err).toContain('this is not a check failure');
      expect(run.err).toContain('shrk surface allow "bundle *" --write');

      const list = await runInProcess(['--cwd', fx, 'surface', 'list', '--json']);
      expect(list.code).toBe(0);
      const s = JSON.parse(list.out) as ISurfaceSummary;
      const bundle = allViews(s).filter((v) => matchesSurfaceSelector('bundle *', v.command));
      expect(bundle.length).toBeGreaterThan(5);
      for (const v of bundle) {
        expect({ command: v.command, callable: v.callable, disabled: v.disabled, source: v.source, deniedBy: v.deniedBy }).toEqual({
          command: v.command,
          callable: false,
          disabled: true,
          source: TierSource.Disabled,
          deniedBy: { selector: 'bundle *', origin: SurfaceLayer.Config },
        });
      }
      expect(findCommandInSummary(s, 'impact')?.callable).toBe(true);

      const text = await runInProcess(['--cwd', fx, 'surface', 'list']);
      expect(text.out).toMatch(/bundle list .*disabled,gated/);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a core command cannot be disabled (warning, still callable), and `surface *` never locks out `surface allow`",
    async () => {
      const fx = consumer("{ disabled: ['doctor', 'surface *'] }");
      const s = await summaryFor(fx);
      const coreWarnings = s.warnings.filter((w) => w.code === 'cannot-disable-core').map((w) => w.command);
      expect(coreWarnings).toContain('doctor');
      expect(coreWarnings).toContain('surface allow');
      expect(findCommandInSummary(s, 'doctor')?.callable).toBe(true);
      expect(findCommandInSummary(s, 'surface allow')?.callable).toBe(true);
      const allow = await runInProcess(['--cwd', fx, 'surface', 'allow', 'doctor']);
      expect(allow.code).toBe(0);
      expect(allow.out).toContain('- surface.disabled: doctor');
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    'a selector that names nothing is warned about, never silently ignored',
    async () => {
      const s = await summaryFor(consumer("{ disabled: ['nosuch *', 'no-such-command'], hidden: ['nosuch2 *'] }"));
      const unknown = s.warnings.filter((w) => w.code === 'unknown-command').map((w) => w.message);
      expect(unknown).toContain('surface.disabled[] references unknown command: nosuch *');
      expect(unknown).toContain('surface.disabled[] references unknown command: no-such-command');
      expect(unknown).toContain('surface.hidden[] references unknown command: nosuch2 *');
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    'the strict config schema accepts `disabled: string[]` and rejects anything else (the real loader)',
    async () => {
      const bad = await loadSurfaceContext({ cwd: consumer("{ disabled: 'bundle list' }") });
      expect(bad.inspection.configLoadError).toBeDefined();
      expect(JSON.stringify(bad.inspection.configLoadError)).toContain('disabled');
      const good = await loadSurfaceContext({ cwd: consumer("{ disabled: ['bundle list'] }") });
      expect(good.inspection.configLoadError).toBeUndefined();
      expect(good.context.surfaceConfig?.disabled).toEqual(['bundle list']);
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe('profiles may carry `disabled`: config wins over the profile, never over itself', () => {
  // A pack-contributed profile is pure data (`ISurfaceProfile`, what
  // load-surface-context turns a manifest's `surfaceProfiles[]` entry into);
  // the composition and the resolver below are the production code paths.
  const lean: ISurfaceProfile = {
    id: 'lean',
    description: 'test profile',
    source: 'pack',
    pack: '@acme/lean-pack',
    disabled: ['bundle *'],
  };
  const index = commandIndexFor(buildRegistry());
  const contextFor = (raw: ISurfaceConfig): ITierResolverContext => ({
    spineCommands: new Set<string>(),
    packContributions: new Map<string, string>(),
    isToolRepo: false,
    ...composeSurfaceConfig(raw, lean),
  });

  test('a profile deny gates the group; an explicit config enable overrides it for one command', () => {
    const s = buildSurfaceSummary(contextFor({ profile: 'lean', enabled: ['bundle list'] }), index);
    expect(findCommandInSummary(s, 'bundle list')?.callable).toBe(true);
    const create = findCommandInSummary(s, 'bundle create');
    expect(create?.callable).toBe(false);
    expect(create?.deniedBy).toEqual({ selector: 'bundle *', origin: SurfaceLayer.Profile });
    expect(create?.detail).toBe("disabled by the 'lean' surface profile ('bundle *')");
  });

  test('a config deny wins over a config enable — warning `enable-disable-conflict`', () => {
    const s = buildSurfaceSummary(contextFor({ profile: 'lean', enabled: ['impact'], disabled: ['impact'] }), index);
    const impact = findCommandInSummary(s, 'impact');
    expect(impact?.callable).toBe(false);
    expect(impact?.deniedBy?.origin).toBe(SurfaceLayer.Config);
    expect(s.warnings.some((w) => w.code === 'enable-disable-conflict' && w.command === 'impact')).toBe(true);
  });
});

describe('`surface deny` / `surface allow` manage surface.disabled', () => {
  test(
    'deny → gated → allow → callable; the profile and the rest of the block survive (spawned from source)',
    () => {
      const fx = consumer("{ profile: 'small-app', hidden: ['graph'] }");
      const cfg = join(fx, 'sharkcraft', 'sharkcraft.config.ts');
      const dry = shrk(fx, ['surface', 'deny', 'bundle *']);
      expect(dry.status).toBe(0);
      expect(dry.stdout).toContain('+ surface.disabled: bundle *');
      expect(dry.stdout).toContain('Dry run');
      expect(readFileSync(cfg, 'utf8')).not.toContain('disabled');

      expect(shrk(fx, ['surface', 'deny', 'bundle *', '--write']).status).toBe(0);
      const written = readFileSync(cfg, 'utf8');
      expect(written).toContain('"bundle *"');
      expect(written).toContain('profile: "small-app"');
      expect(written).toContain('"graph"');
      // The profile's own lists stay in the profile (the pre-round-11 writer
      // planned against the merged view and copied them into the config).
      expect(written).not.toContain('"reposet"');

      const gated = shrk(fx, ['bundle', 'list']);
      expect(gated.status).toBe(SURFACE_NOT_ENABLED_EXIT_CODE);
      expect(gated.stderr).toContain("surface.disabled ('bundle *')");

      expect(shrk(fx, ['surface', 'allow', 'bundle *', '--write']).status).toBe(0);
      expect(readFileSync(cfg, 'utf8')).not.toContain('bundle *');
      expect(shrk(fx, ['bundle', 'list']).status).not.toBe(SURFACE_NOT_ENABLED_EXIT_CODE);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    '`surface hide` edits the config\'s own block — never the profile-merged view — and keeps `profile`',
    () => {
      const fx = consumer("{ profile: 'small-app' }");
      expect(shrk(fx, ['surface', 'hide', 'inspect', '--write']).status).toBe(0);
      const written = readFileSync(join(fx, 'sharkcraft', 'sharkcraft.config.ts'), 'utf8');
      expect(written).toContain('"inspect"');
      expect(written).toContain('profile: "small-app"');
      expect(written).not.toContain('"bundle"');
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    'refusals (2): a core command, a selector naming nothing, enable over a config deny, allow of a non-entry',
    async () => {
      const fx = consumer("{ disabled: ['bundle *'] }");
      const core = await runInProcess(['--cwd', fx, 'surface', 'deny', 'doctor']);
      expect(core.code).toBe(2);
      expect(core.err).toContain('Cannot disable a core command (doctor)');
      const nothing = await runInProcess(['--cwd', fx, 'surface', 'deny', 'nosuch *']);
      expect(nothing.code).toBe(2);
      expect(nothing.err).toContain('names no command');
      const enable = await runInProcess(['--cwd', fx, 'surface', 'enable', 'bundle', 'list']);
      expect(enable.code).toBe(2);
      expect(enable.err).toContain("shrk surface allow 'bundle *' --write");
      const allow = await runInProcess(['--cwd', fx, 'surface', 'allow', 'bundle list']);
      expect(allow.code).toBe(2);
      expect(allow.err).toContain("'bundle list' is not in surface.disabled");
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe('the start screen honours the surface', () => {
  test(
    'a hidden or disabled curated command leaves the start screen',
    async () => {
      const fx = consumer("{ hidden: ['impact'], disabled: ['gen'] }");
      const run = await runInProcess(['--cwd', fx, '--help']);
      expect(run.code).toBe(0);
      expect(run.out).not.toContain('$ shrk impact');
      expect(run.out).not.toContain('$ shrk gen ');
      expect(run.out).toContain('$ shrk apply');
      expect(run.out).toContain("2 curated command(s) are hidden or disabled by this repository's surface config");
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    'with no surface{} block it is byte-identical to the curated screen',
    async () => {
      const run = await runInProcess(['--cwd', consumer(), '--help']);
      expect(run.code).toBe(0);
      expect(run.out).toBe(renderStartScreen());
    },
    SPAWN_TIMEOUT_MS,
  );
});
