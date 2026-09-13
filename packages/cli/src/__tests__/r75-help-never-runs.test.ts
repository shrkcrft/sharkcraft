/**
 * r75 — `--help` never runs the command (round 11 §5.3).
 *
 * Only a LEADING `--help` used to be intercepted, so on every internally
 * dispatched subverb — and after any positional or flag — the command body ran
 * instead: `report site --help` wrote twelve HTML files, `graph index --help`
 * built the store, `ingest repository` / `onboard adopt regenerate` / `surface
 * reset` executed. Now the dispatcher intercepts `--help` / `-h` ANYWHERE
 * before `--`, before the guard, the surface gate, the inspection and the body.
 *
 * The property is proven over THE command index (every trie path, every
 * declared subverb at any depth, every catalog-documented subverb): exit 0,
 * the help names the path and shows a usage line, it is fast, and an mkdtemp
 * fixture is byte-identical afterwards. It runs through the real `runCli`
 * (in-process, the entry the binary calls) with the real `buildRegistry()`;
 * the dangerous cases are also spawned from source.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildRegistry, runCli } from '../main.ts';
import { helpTopicFor, wantsHelp } from '../dispatch/help-intercept.ts';
import { CommandDispatchKind } from '../surface/command-dispatch-kind.ts';
import { buildCommandIndex, commandIndexFor, setActiveCommandRegistry } from '../surface/command-index.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');

const roots: string[] = [];
afterAll(() => {
  setActiveCommandRegistry(undefined);
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A committed consumer repo: package.json, a config, one source file, a README. */
function consumerFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-help-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'consumer-app', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'consumer-app' };\n",
    'src/index.ts': "export const hello = (): string => 'hi';\n",
    'README.md': '# consumer-app\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  const git = (...a: string[]): void =>
    void spawnSync('git', ['-c', 'user.email=r75@test', '-c', 'user.name=r75', '-c', 'commit.gpgsign=false', ...a], {
      cwd: root,
    });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'r75');
  return root;
}

/** Every path under `root` (`.git` excluded): directories as `dir`, files as a content hash. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (rel === '' && name === '.git') continue;
      const abs = join(dir, name);
      const key = rel === '' ? name : `${rel}/${name}`;
      if (statSync(abs).isDirectory()) {
        out[key] = 'dir';
        walk(abs, key);
      } else {
        out[key] = createHash('sha1').update(readFileSync(abs)).digest('hex');
      }
    }
  };
  walk(root, '');
  return out;
}

interface IRun {
  readonly code: number | 'timeout';
  readonly out: string;
  readonly err: string;
  readonly ms: number;
}

/** `runCli` in-process with stdout/stderr captured; a run that never returns reports `timeout`. */
async function runInProcess(argv: readonly string[], timeoutMs = 5_000): Promise<IRun> {
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
  const t0 = performance.now();
  try {
    const code = await Promise.race([
      runCli(argv),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
    ]);
    return { code, out, err, ms: performance.now() - t0 };
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

/** A line that shows how to invoke a command. */
const USAGE_LINE = /^\s*shrk\s/m;

describe('r75 — `<path> --help` over the WHOLE command index: exit 0, help, runs nothing', () => {
  test('every trie path, declared subverb and catalog subverb', async () => {
    const fx = consumerFixture();
    const before = snapshot(fx);
    const index = buildCommandIndex(buildRegistry());
    const entries = index.entries.filter((e) => e.dispatch !== CommandDispatchKind.Meta);
    // Guard against a vacuous sweep: the index must carry the declared subverbs.
    expect(entries.length).toBeGreaterThan(400);
    expect(index.byPath.get('graph importers')?.declared).toBe(true);
    expect(index.byPath.get('search tuning explain')?.declared).toBe(true);
    // The usage ledger is the dispatcher's own opt-out log, not a command body;
    // it is switched off so "nothing was written" is about the command alone.
    const prev = process.env.SHARKCRAFT_USAGE_DISABLED;
    process.env.SHARKCRAFT_USAGE_DISABLED = '1';
    // The PROCESS cwd is the fixture too: a regressed intercept whose body
    // writes relative to `process.cwd()` (not `--cwd`) must land where the
    // snapshot looks — never silently in the repository.
    const prevCwd = process.cwd();
    process.chdir(fx);
    const failures: string[] = [];
    try {
      for (const e of entries) {
        const r = await runInProcess(['--cwd', fx, ...e.tokens, '--help']);
        if (r.code !== 0) failures.push(`${e.path}: exit ${r.code} ${r.err.slice(0, 120)}`);
        else if (!r.out.includes(e.path)) failures.push(`${e.path}: help does not name the path`);
        else if (!USAGE_LINE.test(r.out)) failures.push(`${e.path}: no usage line`);
        else if (r.ms > 2_000) failures.push(`${e.path}: ${Math.round(r.ms)}ms — help must be instant`);
      }
    } finally {
      process.chdir(prevCwd);
      if (prev === undefined) delete process.env.SHARKCRAFT_USAGE_DISABLED;
      else process.env.SHARKCRAFT_USAGE_DISABLED = prev;
    }
    expect(failures).toEqual([]);
    expect(snapshot(fx)).toEqual(before);
  }, 300_000);

  test('`-h` is the same intercept', async () => {
    const fx = consumerFixture();
    const before = snapshot(fx);
    process.env.SHARKCRAFT_USAGE_DISABLED = '1';
    try {
      const r = await runInProcess(['--cwd', fx, 'report', 'site', '-h']);
      expect(r.code).toBe(0);
      expect(r.out).toContain('report site');
    } finally {
      delete process.env.SHARKCRAFT_USAGE_DISABLED;
    }
    expect(snapshot(fx)).toEqual(before);
  });
});

describe('r75 — spawned from source: help after a subverb / positional / flag writes nothing', () => {
  const cases: readonly (readonly [readonly string[], string])[] = [
    [['report', 'site', '--help'], 'report site'],
    [['graph', 'index', '--help'], 'graph index'],
    [['check', 'registry-lifecycle', '--help'], 'check registry-lifecycle'],
    [['doctor', '--json', '--help'], 'doctor'],
    [['impact', 'src/index.ts', '--help'], 'impact'],
    [['graph', 'importers', 'foo', '--help'], 'graph importers'],
    [['context', '--task', 'x', '--help'], 'context'],
    [['surface', 'reset', '--write', '-h'], 'surface reset'],
    [['ingest', 'repository', '--help'], 'ingest repository'],
    [['onboard', 'adopt', 'regenerate', '--help'], 'onboard adopt regenerate'],
  ];
  test('each prints its help at exit 0 and the fixture is byte-identical', () => {
    const fx = consumerFixture();
    const before = snapshot(fx);
    for (const [argv, path] of cases) {
      const r = shrk(fx, argv);
      expect({ argv: argv.join(' '), status: r.status }).toEqual({ argv: argv.join(' '), status: 0 });
      expect(r.stdout).toContain(path);
      expect(r.stdout).toMatch(USAGE_LINE);
    }
    // No `.sharkcraft/reports/site/*.html`, no graph store, no ingestion drafts.
    expect(snapshot(fx)).toEqual(before);
  }, 300_000);

  test('`languages run -- --help`: a token after `--` passes through, never intercepted', () => {
    expect(wantsHelp(['run', '--', '--help'])).toBe(false);
    expect(wantsHelp(['run', '--json', '--help'])).toBe(true);
    const fx = consumerFixture();
    const r = shrk(fx, ['languages', 'run', '--', '--help']);
    // The dry-run plan ran (languages run is dry-run by default) — not the help
    // page, and not a crash or an empty answer either.
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('=== Language run plan ===');
    expect(r.stdout).toContain('Dry-run: no commands were executed');
    expect(r.stdout).not.toContain('languages run — ');
  }, 120_000);
});

describe('r75 — help resolves internally-dispatched subverbs through the index', () => {
  test('`help graph importers` and `help api-diff capture` print real usage (they have no catalog row)', () => {
    const fx = consumerFixture();
    for (const [argv, usage] of [
      [['help', 'graph', 'importers'], 'shrk graph importers <file|module-specifier>'],
      [['help', 'api-diff', 'capture'], 'shrk api-diff capture --output <path>'],
    ] as const) {
      const r = shrk(fx, argv);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(usage);
    }
  }, 120_000);

  test('the help topic is the LONGEST path the index knows, canonical and never invented', () => {
    const index = commandIndexFor(buildRegistry());
    expect(helpTopicFor(index, ['graph'], ['importers', 'foo', '--help'])).toEqual(['graph', 'importers']);
    expect(helpTopicFor(index, ['bundle'], ['replay', 'scaffold', 'github-actions', '--help'])).toEqual([
      'bundle',
      'replay',
      'scaffold',
      'github-actions',
    ]);
    expect(helpTopicFor(index, ['check'], ['import-hygiene', '--help'])).toEqual(['check', 'imports']);
    expect(helpTopicFor(index, ['impact'], ['src/index.ts', '--help'])).toEqual(['impact']);
    expect(helpTopicFor(index, ['templates'], ['lst', '--help'])).toEqual(['templates']);
  });

  test('an unknown tail under a known path is an unknown topic (1), never the group listing at 0', async () => {
    const r = await runInProcess(['help', 'templates', 'lst']);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no such help topic: 'templates lst'");
    expect(r.err).toContain('templates list');
    expect(r.out).toBe('');
  });
});
