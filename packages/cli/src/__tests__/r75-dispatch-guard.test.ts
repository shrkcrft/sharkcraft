/**
 * r75 — the dispatcher invocation guard (round 11 §5.2a / §5.2b / L-3 / §1.2#5).
 *
 * A wrong command used to run something else and exit 0: `shrk check rules
 * --tag auth` printed a green full sweep, `shrk templates lst` printed group
 * help at 0, `shrk api-diff status` reported a missing baseline FILE named
 * `status`, and a leading `--no-hints` made `shrk scaffolds list` "not a
 * command". Now the dispatcher judges every invocation against what the
 * handler DECLARES (subverbs / positional mode / flags) before anything runs,
 * and a universal post-run detector catches a flag nothing read.
 *
 * Real `buildRegistry()` throughout; the user-visible cases are spawned from
 * source against an mkdtemp consumer fixture.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { buildRegistry, runCli } from '../main.ts';
import { parseArgs, type CommandRegistry, type ICommandHandler } from '../command-registry.ts';
import { COMMAND_CATALOG } from '../commands/command-catalog.ts';
import { buildCommandsDoctorReport } from '../commands/commands.command.ts';
import { gatesCheckCommand, gatesCoverageCommand, gatesTryCommand } from '../commands/gates.command.ts';
import { qualityCommand } from '../commands/quality.command.ts';
import { smartContextCommand } from '../commands/smart-context.command.ts';
import { GLOBAL_FLAGS, PATH_TRANSPARENCY, SOFT_FLAGS, withoutPathGlobals } from '../dispatch/global-flags.ts';
import { guardInvocation, isVerbShaped } from '../dispatch/guard-invocation.ts';
import type { IInvocationRejection } from '../dispatch/invocation-rejection.ts';
import { PositionalMode } from '../dispatch/positional-mode.ts';
import { ReadTrackingMap } from '../dispatch/read-tracking-map.ts';
import type { ISubverbSpec } from '../dispatch/subverb-spec.ts';
import { settleUnreadFlags, tracksFlagReads } from '../dispatch/unread-flags.ts';
import { walkDeclaredSubverbs } from '../dispatch/walk-declared-subverbs.ts';
import { ExitCode, isGateVerb, usageExitFor, VERDICT_PATH_TOKENS } from '../exit-codes.ts';
import { CommandDispatchKind } from '../surface/command-dispatch-kind.ts';
import { cleanCommandPath, commandIndexFor, setActiveCommandRegistry } from '../surface/command-index.ts';
import { extractCommandPath } from '../usage/usage-log.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');

const roots: string[] = [];
afterAll(() => {
  setActiveCommandRegistry(undefined);
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function consumerFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-guard-'));
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

function shrk(cwd: string, argv: readonly string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('bun', [CLI_MAIN, ...argv], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, SHARKCRAFT_USAGE_DISABLED: '1' },
    timeout: 180_000,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

async function runInProcess(argv: readonly string[]): Promise<{ code: number | 'timeout'; out: string; err: string }> {
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
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 30_000)),
    ]);
    return { code, out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

/** The guard's answer for `argv`, descended through the real trie exactly as `runCliInner` does. */
function guard(registry: CommandRegistry, argv: readonly string[], cwd: string): IInvocationRejection | undefined {
  const res = registry.resolve(argv, PATH_TRANSPARENCY);
  return guardInvocation({
    registry,
    handler: res.handler,
    matchedPath: res.matchedPath,
    trieChildren: [...res.node.children.keys()],
    parsed: parseArgs(res.rest, { booleanFlags: res.handler?.booleanFlags }),
    cwd,
  });
}

/** Every declared subverb chain below a handler: [chain of names, spec]. */
function declaredChains(specs: readonly ISubverbSpec[] | undefined, prefix: readonly string[] = []): [string[], ISubverbSpec][] {
  const out: [string[], ISubverbSpec][] = [];
  for (const spec of specs ?? []) {
    const chain = [...prefix, spec.name];
    out.push([chain, spec]);
    out.push(...declaredChains(spec.subverbs, chain));
  }
  return out;
}

describe('r75 — spawned from source: a wrong invocation never runs something else at exit 0', () => {
  // Round 11 final integration: bare `shrk check` is a registered verdict verb
  // (its sweep settles 2 on a doctor shortfall), so a malformed `check`
  // invocation exits 3 — the documented split that keeps its 2 meaning "ran
  // but proved nothing". These two cases read 2 while `check` was unregistered.
  test('`check rules --tag auth` → 3 (usage error on a verdict verb), and `rules` is named as a command of its own', () => {
    const r = shrk(consumerFixture(), ['check', 'rules', '--tag', 'auth']);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('`shrk check` has no `rules` subcommand');
    expect(r.stderr).toContain('`rules` is a command of its own: shrk rules');
    expect(r.stdout).not.toContain('Check summary');
  }, 120_000);

  // Round 11 review (intentional change): an undocumented flag is refused
  // BEFORE the body runs (`judgeInvocation`), so the sweep no longer prints
  // first — the post-run detector stays only as the backstop.
  test('`check --tag auth` → 3, refused before the sweep runs, naming --tag', () => {
    const r = shrk(consumerFixture(), ['check', '--tag', 'auth']);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('--tag is not a flag of this command');
    expect(r.stdout).not.toContain('Check summary');
  }, 120_000);

  test('`templates lst` → 2 with did-you-mean; a bare group still lists its verbs at 0', () => {
    const fx = consumerFixture();
    const typo = shrk(fx, ['templates', 'lst']);
    expect(typo.status).toBe(2);
    expect(typo.stderr).toContain('Did you mean `shrk templates list`?');
    const bare = shrk(fx, ['knowledge']);
    expect(bare.status).toBe(0);
    expect(bare.stdout).toContain('knowledge list');
  }, 120_000);

  test('`api-diff status` / `feedback zzbogus` → 2: no such verb, no such file — never an ENOENT', () => {
    const fx = consumerFixture();
    const api = shrk(fx, ['api-diff', 'status']);
    expect(api.status).toBe(2);
    expect(api.stderr).toContain('has no `status` verb, and no file named `status` exists');
    expect(api.stderr).toContain('capture — shrk api-diff capture --output <path>');
    expect(api.stderr).toMatch(/`status` is a verb of: .*shrk graph status/);
    expect(api.stderr).not.toContain('ENOENT');
    const fb = shrk(fx, ['feedback', 'zzbogus']);
    expect(fb.status).toBe(2);
    expect(fb.stderr).toContain('has no `zzbogus` verb, and no file named `zzbogus` exists');
    expect(fb.stderr).not.toContain('ENOENT');
  }, 120_000);

  test('the Path rule never blocks a real file or a path-shaped token', () => {
    const fx = consumerFixture();
    // A path-shaped missing file keeps the command's own honest error.
    const missing = shrk(fx, ['api-diff', 'missing.json']);
    expect(missing.stderr).toContain('Baseline read error');
    expect(missing.stderr).not.toContain('has no `missing.json` verb');
    // A real baseline still diffs — and so does a baseline literally named `status`.
    expect(shrk(fx, ['graph', 'index']).status).toBe(0);
    expect(shrk(fx, ['api-diff', 'capture', '--output', 'baseline.json']).status).toBe(0);
    const diff = shrk(fx, ['api-diff', 'baseline.json']);
    expect(diff.status).toBe(0);
    expect(diff.stdout).toContain('API surface diff');
    copyFileSync(join(fx, 'baseline.json'), join(fx, 'status'));
    const named = shrk(fx, ['api-diff', 'status']);
    expect(named.status).toBe(0);
    expect(named.stdout).toContain('API surface diff');
  }, 300_000);

  test('`doctor zzbogus` → 3 (a verdict verb) and `quality --bogus` → 3, before anything runs', () => {
    const fx = consumerFixture();
    const doc = shrk(fx, ['doctor', 'zzbogus']);
    expect(doc.status).toBe(ExitCode.UsageError);
    expect(doc.stdout).toBe('');
    const q = shrk(fx, ['quality', '--bogus']);
    expect(q.status).toBe(ExitCode.UsageError);
    // Round 13: THE one refusal format (was `Unknown flag "--bogus" for \`shrk quality\``).
    expect(q.stderr).toContain('`shrk quality`: --bogus is not a flag of this command');
    expect(q.stdout).toBe('');
  }, 120_000);
});

describe('r75 — L-3: the global flags never break dispatch, leading, interleaved or trailing', () => {
  test('`--no-hints` / `--strict` / `--exit-trailer` / `--cwd` / `--compress` anywhere around `scaffolds list`', () => {
    const fx = consumerFixture();
    const other = consumerFixture();
    for (const argv of [
      ['--no-hints', 'scaffolds', 'list'],
      ['scaffolds', '--no-hints', 'list'],
      ['scaffolds', 'list', '--no-hints'],
      ['--strict', 'scaffolds', 'list'],
      ['--exit-trailer', 'scaffolds', 'list'],
      ['scaffolds', 'list', '--exit-trailer'],
      ['--cwd', fx, 'scaffolds', 'list'],
      ['scaffolds', 'list', '--cwd', fx],
      ['--compress', 'scaffolds', 'list'],
    ]) {
      const r = shrk(other, argv);
      expect({ argv: argv.join(' ').replace(fx, '<fx>'), status: r.status }).toEqual({
        argv: argv.join(' ').replace(fx, '<fx>'),
        status: 0,
      });
      expect(r.stdout).toContain('Scaffold patterns');
      expect(r.stderr).not.toContain("doesn't have");
    }
  }, 300_000);

  test('a leading `--no-hints` keeps the verdict path: `--exit-trailer` still prints the trailer', () => {
    const r = shrk(consumerFixture(), ['--no-hints', '--exit-trailer', 'check', 'wiring']);
    expect(r.stderr.trimEnd().split('\n').pop()).toMatch(/^shrk-exit: \d$/);
  }, 120_000);

  test('every declared flag set accepts every global flag (so a trailing one never trips the guard)', () => {
    const registry = buildRegistry();
    const fx = consumerFixture();
    const failures: string[] = [];
    for (const { path, handler } of registry.listAll()) {
      const chains: string[][] = [[], ...declaredChains(handler.subverbs).map(([c]) => c)];
      for (const chain of chains) {
        if (!walkDeclaredSubverbs(handler, path, chain).flags) continue;
        for (const g of GLOBAL_FLAGS) {
          const r = guard(registry, [...path, ...chain, `--${g}`], fx);
          if (r) failures.push(`${[...path, ...chain].join(' ')} --${g}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test('a global flag is stepped over only INSIDE the path: `doctor --strict warnings` keeps its value', () => {
    const registry = buildRegistry();
    const descend = (argv: string[]): { path: string; rest: string[] } => {
      const r = registry.resolve(argv, PATH_TRANSPARENCY);
      return { path: r.matchedPath.join(' '), rest: r.rest };
    };
    // Past the path a bare `--strict` stays in front of its value — never a positional.
    expect(descend(['doctor', '--strict', 'warnings'])).toEqual({ path: 'doctor', rest: ['--strict', 'warnings'] });
    expect(descend(['doctor', '--strict=warnings'])).toEqual({ path: 'doctor', rest: ['--strict=warnings'] });
    expect(descend(['doctor', '--no-hints', '--strict', 'errors'])).toEqual({
      path: 'doctor',
      rest: ['--strict', 'errors', '--no-hints'],
    });
    // Inside the path (the next token continues it) the run is stepped over and hoisted.
    expect(descend(['--strict', 'doctor'])).toEqual({ path: 'doctor', rest: ['--strict'] });
    expect(descend(['--no-hints', '--strict', 'scaffolds', 'list'])).toEqual({
      path: 'scaffolds list',
      rest: ['--no-hints', '--strict'],
    });
    expect(descend(['scaffolds', '--no-hints', 'list'])).toEqual({ path: 'scaffolds list', rest: ['--no-hints'] });
    // A declared subverb continues the path too.
    expect(descend(['check', '--strict', 'wiring'])).toEqual({ path: 'check', rest: ['wiring', '--strict'] });
    // A self-contained flag never swallows the positional after it.
    expect(descend(['task', '--no-hints', 'add a thing'])).toEqual({ path: 'task', rest: ['add a thing', '--no-hints'] });
    // Everything after `--` stays literal.
    expect(descend(['scaffolds', 'list', '--no-hints', '--', '--strict'])).toEqual({
      path: 'scaffolds list',
      rest: ['--no-hints', '--', '--strict'],
    });
  });

  test('the verdict path reads the SAME descent: `doctor --strict warnings` is `doctor`', () => {
    const registry = buildRegistry();
    const verdict = (argv: string[]): string =>
      extractCommandPath(withoutPathGlobals(argv, registry), VERDICT_PATH_TOKENS);
    expect(verdict(['doctor', '--strict', 'warnings'])).toBe('doctor');
    expect(verdict(['--no-hints', 'check', 'wiring'])).toBe('check wiring');
    expect(verdict(['--strict', 'docs', 'references', 'check'])).toBe('docs references check');
    // An alias stays as typed (the usage record), the global flag stepped over.
    expect(verdict(['scaffold', '--no-hints', 'list'])).toBe('scaffold list');
  });

  test('spawned: `doctor --strict <level>` ≡ `doctor --strict=<level>` — the level is read, never refused', () => {
    const fx = consumerFixture();
    for (const level of ['warnings', 'errors']) {
      const spaced = shrk(fx, ['doctor', '--strict', level]);
      const joined = shrk(fx, ['doctor', `--strict=${level}`]);
      expect({ level, status: spaced.status }).toEqual({ level, status: joined.status });
      expect(spaced.stderr).not.toContain('subcommand');
      // `doctor` names the strict mode it ran in — `errors` proves the value was read, not defaulted.
      expect(spaced.stdout).toContain(`strict=${level}`);
    }
  }, 300_000);
});

describe('r75 — declarations: what each handler declares is what it dispatches', () => {
  const registry = buildRegistry();
  const fx = consumerFixture();

  test('the plan’s internally-dispatched subverbs are declared (graph code-intel, api-diff capture, …)', () => {
    const index = commandIndexFor(registry);
    for (const p of [
      'graph index',
      'graph status',
      'graph importers',
      'graph cycles',
      'graph unresolved',
      'graph deps',
      'graph why',
      'graph export',
      'graph imports',
      'api-diff capture',
      'check wiring',
      'search tuning explain',
      'onboard adopt regenerate',
      'feedback rules doctor',
    ]) {
      expect({ p, declared: index.byPath.get(p)?.declared }).toEqual({ p, declared: true });
    }
  });

  test('every declared subverb, at every depth, passes the guard', () => {
    const failures: string[] = [];
    let checked = 0;
    for (const { path, handler } of registry.listAll()) {
      for (const [chain] of declaredChains(handler.subverbs)) {
        checked += 1;
        const r = guard(registry, [...path, ...chain], fx);
        if (r) failures.push(`${[...path, ...chain].join(' ')}: ${r.message.split('\n')[0]}`);
      }
    }
    expect(checked).toBeGreaterThan(150);
    expect(failures).toEqual([]);
  });

  test('catalog ⊆ declarations: a catalog row under a declaring handler names a declared subverb', () => {
    const violations: string[] = [];
    for (const row of COMMAND_CATALOG) {
      const path = cleanCommandPath(row.command);
      if (path.length === 0) continue;
      const res = registry.resolve(path.split(' '));
      if (!res.handler?.subverbs || res.rest.length === 0) continue;
      let specs: readonly ISubverbSpec[] | undefined = res.handler.subverbs;
      for (const token of res.rest) {
        if (!specs) break;
        const match: ISubverbSpec | undefined = specs.find((s) => s.name === token || (s.aliases ?? []).includes(token));
        if (!match) {
          violations.push(`${row.command} → \`${token}\` is not declared under ${res.matchedPath.join(' ')}`);
          break;
        }
        specs = match.subverbs;
      }
    }
    expect(violations).toEqual([]);
    const report = buildCommandsDoctorReport(registry);
    expect(report.issues.filter((i) => i.code === 'undeclared-internal-subverb')).toEqual([]);
  });

  test('every `None` declaration and every pure group refuses `<path> zz-not-a-verb` — never 0', () => {
    const targets: string[][] = [];
    const groups = new Set<string>();
    for (const { path, handler } of registry.listAll()) {
      if (handler.positionals === PositionalMode.None) targets.push([...path]);
      for (const [chain, spec] of declaredChains(handler.subverbs)) {
        if (spec.positionals === PositionalMode.None) targets.push([...path, ...chain]);
      }
      for (let n = 1; n < path.length; n += 1) {
        const pre = registry.resolve(path.slice(0, n));
        if (!pre.handler && pre.node.children.size > 0) groups.add(path.slice(0, n).join(' '));
      }
    }
    for (const g of groups) targets.push(g.split(' '));
    expect(targets.length).toBeGreaterThan(60);
    const failures: string[] = [];
    for (const argv of targets) {
      const r = guard(registry, [...argv, 'zz-not-a-verb'], fx);
      const label = argv.join(' ');
      if (!r) failures.push(`${label}: accepted`);
      else if (r.exitCode !== usageExitFor(label) || r.exitCode === 0) failures.push(`${label}: exit ${r.exitCode}`);
    }
    expect(failures).toEqual([]);
  });

  test('free positionals are never refused', () => {
    for (const argv of [
      ['task', 'add a thing'],
      ['impact', 'src/index.ts'],
      ['explain', 'foo'],
      ['why', 'src/index.ts'],
      ['graph', 'some-asset-id'],
      ['search', 'tuning', 'explain', 'q'],
      ['search', 'anything', 'at', 'all'],
      ['dev', 'add a thing'],
      ['watch', 'add a thing'],
      ['reuse', 'a date picker'],
      ['contract', 'add a thing'],
      ['trace', 'foo'],
      ['trace', 'literal', 'foo'],
      ['registry', 'handlers', 'list'],
      ['registry', 'list', 'handlers'],
      ['check', 'generation', 'svc', 'foo'],
      ['smart-context', 'add a thing'],
      ['task', 'decompose', 'add a thing'],
      ['feedback', 'src/index.ts'],
      ['api-diff', 'src/index.ts'],
      ['review', 'src/index.ts'],
      ['apply', 'src/index.ts'],
      ['wiring', 'test', '{"id":"x"}'],
      ['compress', '-'],
    ]) {
      expect({ argv: argv.join(' '), r: guard(registry, argv, fx)?.message }).toEqual({ argv: argv.join(' '), r: undefined });
    }
  });

  test('no documented invocation is refused: every flag a usage or catalog row documents, and a real positional', () => {
    const index = commandIndexFor(registry);
    const failures: string[] = [];
    const flagRe = /(?:^|[^A-Za-z0-9-])--([a-z0-9][a-z0-9-]*)/gi;
    for (const e of index.entries) {
      if (e.dispatch === CommandDispatchKind.Meta) continue;
      const res = registry.resolve(e.tokens);
      if (!res.handler) continue;
      const docs = [e.usage ?? '', e.catalogEntry?.command ?? '', ...e.variants];
      const flags = new Set(docs.flatMap((d) => [...d.matchAll(flagRe)].map((m) => m[1]!)));
      for (const f of flags) {
        const r = guard(registry, [...e.tokens, `--${f}=x`], fx);
        if (r) failures.push(`${e.path} --${f}: ${r.message.split('\n')[0]}`);
      }
      const walk = walkDeclaredSubverbs(res.handler, res.matchedPath, res.rest);
      const escaped = e.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const takesPositional = new RegExp(`shrk (?:\\[--cwd <dir>\\] )?${escaped} <[^|>]+>`).test(e.usage ?? '');
      if (takesPositional && walk.level.positionals !== PositionalMode.None) {
        const r = guard(registry, [...e.tokens, 'src/index.ts'], fx);
        if (r) failures.push(`${e.path} <positional>: ${r.message.split('\n')[0]}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test('the migrated flag guards keep their exact accepted sets (gates check / coverage / try, quality)', () => {
    const accepts = (h: ICommandHandler, f: string): boolean => h.flags?.has(f) === true;
    // The one-verb extras stay on their own verb.
    expect(accepts(gatesCheckCommand, 'allow-empty')).toBe(true);
    expect(accepts(gatesCheckCommand, 'fail-on-dead-units')).toBe(false);
    expect(accepts(gatesCoverageCommand, 'fail-on-dead-units')).toBe(true);
    expect(accepts(gatesCoverageCommand, 'allow-empty')).toBe(false);
    expect(accepts(gatesTryCommand, 'flags')).toBe(true);
    expect(accepts(gatesTryCommand, 'allow-empty')).toBe(false);
    for (const h of [gatesCheckCommand, gatesCoverageCommand, gatesTryCommand]) {
      for (const f of ['json', 'plane', 'only', 'changed-only', 'since', 'base', 'rule-file', 'wiring', 'margin']) {
        expect({ h: h.name, f, ok: accepts(h, f) }).toEqual({ h: h.name, f, ok: true });
      }
    }
    for (const f of ['ci', 'fail-fast', 'min-readiness', 'require-pack-signatures', 'no-color']) {
      expect(accepts(qualityCommand, f)).toBe(true);
    }
  });

  test('every declared flag set refuses a bogus flag with usageExitFor(path)', () => {
    const failures: string[] = [];
    let checked = 0;
    for (const { path, handler } of registry.listAll()) {
      const chains: string[][] = [[], ...declaredChains(handler.subverbs).map(([c]) => c)];
      for (const chain of chains) {
        const walk = walkDeclaredSubverbs(handler, path, chain);
        if (!walk.flags) continue;
        checked += 1;
        const label = walk.path.join(' ');
        const r = guard(registry, [...path, ...chain, '--zz-bogus-flag'], fx);
        if (r?.exitCode !== usageExitFor(label)) failures.push(`${label}: ${r?.exitCode}`);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(16);
    expect(failures).toEqual([]);
    // The documented split, concretely: 3 on verdict verbs, 2 elsewhere.
    expect(guard(registry, ['graph', 'cycles', '--zz'], fx)?.exitCode).toBe(ExitCode.UsageError);
    expect(guard(registry, ['graph', 'importers', 'x', '--zz'], fx)?.exitCode).toBe(ExitCode.NotVerified);
    expect(guard(registry, ['gates', 'try', '--zz'], fx)?.exitCode).toBe(ExitCode.UsageError);
    // The bless step and the bare sweep are verdict verbs (TQ-5); their
    // informational siblings are not.
    expect(usageExitFor('baseline update')).toBe(ExitCode.UsageError);
    expect(usageExitFor('check')).toBe(ExitCode.UsageError);
    expect(usageExitFor('baseline list')).toBe(ExitCode.NotVerified);
  });

  test('the verb-shape rule', () => {
    for (const t of ['status', 'capture', 'zz-bogus', 'a1']) expect(isVerbShaped(t)).toBe(true);
    for (const t of ['baseline.json', 'src/a.ts', 'Status', '{"a":1}', '-', 'a:b', 'C:\\x', 'k=v']) {
      expect({ t, v: isVerbShaped(t) }).toEqual({ t, v: false });
    }
  });
});

describe('r75 — the post-run unknown-flag detector', () => {
  test('ReadTrackingMap: get / has / delete mark one key; any whole-map read marks every key', () => {
    const m = ReadTrackingMap.from(new Map<string, boolean>([['a', true], ['b', true], ['c', true]]));
    m.get('a');
    m.has('b');
    expect([m.wasRead('a'), m.wasRead('b'), m.wasRead('c')]).toEqual([true, true, false]);
    const n = ReadTrackingMap.from(new Map<string, boolean>([['x', true]]));
    void [...n];
    expect(n.wasRead('x')).toBe(true);
    const o = ReadTrackingMap.from(new Map<string, boolean>([['y', true]]));
    void new Map(o);
    expect(o.wasRead('y')).toBe(true);
  });

  test('settleUnreadFlags: the exit changes ONLY for an undocumented, unread, non-presentation flag on a 0', () => {
    const quiet = (): void => undefined;
    const docs = ['shrk demo [--limit N] [--json]'];
    const settle = (unread: string[], exit: number, path = 'demo'): number =>
      settleUnreadFlags({ unread, path, documentation: docs, exit, write: quiet });
    expect(settle(['tag'], 0)).toBe(ExitCode.NotVerified);
    expect(settle(['tag'], 0, 'finish')).toBe(ExitCode.UsageError); // a verdict verb
    expect(settle(['limit'], 0)).toBe(0); // documented-but-unread never changes the exit
    expect(settle(['verbose'], 0)).toBe(0); // presentation-only: warned, kept
    expect(SOFT_FLAGS.has('verbose')).toBe(true);
    expect(settle(['tag'], 1)).toBe(1); // a non-zero verdict is kept
    expect(settle([], 0)).toBe(0);
  });

  test('a real documented-but-unread flag never changes the exit: `doctor --provider auto` ≡ `doctor`', () => {
    const fx = consumerFixture();
    const bare = shrk(fx, ['doctor']);
    const withFlag = shrk(fx, ['doctor', '--provider', 'auto']);
    expect(withFlag.status).toBe(bare.status);
    expect(withFlag.stderr).not.toContain('is not a flag of this command');
  }, 180_000);

  test('a real undocumented presentation flag is warned about but keeps 0: `stats --verbose`', () => {
    const r = shrk(consumerFixture(), ['stats', '--verbose']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('--verbose is not a flag of this command');
  }, 120_000);

  test('smart-context (re-executes process.argv) and declared-flag handlers are exempt', () => {
    expect(smartContextCommand.forwardsArgv).toBe(true);
    expect(tracksFlagReads(smartContextCommand, walkDeclaredSubverbs(smartContextCommand, ['smart-context'], []))).toBe(false);
    expect(tracksFlagReads(qualityCommand, walkDeclaredSubverbs(qualityCommand, ['quality'], []))).toBe(false);
  });
});

/**
 * §1.2#5 — the registry-wide sweep the knowledge lane deferred: every
 * registered path whose usage REQUIRES an input selector (a `--flag` or a
 * `<placeholder>` right after the path, outside any `[…]`; a `<a|b>`
 * alternation names subverbs, not a selector) refuses a bare invocation —
 * never exit 0, never zero bytes. The per-item query verbs guarded by
 * `requireInputSelector` exit exactly 3 with their usage line.
 */
function stripOptional(text: string): string {
  let out = text;
  let prev: string;
  do {
    prev = out;
    out = out.replace(/\[[^[\]]*\]/g, ' ');
  } while (out !== prev);
  return out;
}

function requiresSelector(usage: string, path: string): boolean {
  for (const alt of usage.split(/\n|\s+\|\s+(?=shrk\b)|\s+·\s+/)) {
    const clean = alt.replace(/\[--cwd <dir>\]\s*/, '').trim();
    const at = clean.indexOf(`shrk ${path}`);
    if (at < 0) continue;
    const after = stripOptional(clean.slice(at + 5 + path.length));
    return after
      .trim()
      .split(/\s+/)
      .some((t) => t.startsWith('--') || (t.startsWith('<') && !t.includes('|')));
  }
  return false;
}

/** Long-running, interactive, stdin-reading or machine-mutating verbs — not run bare in-process. */
const SWEEP_SKIP =
  /^(watch|dashboard|mcp|smart-context|ask|delegate|spike|release|install|upgrade|completion|ide|packs watch|packs dev-status|compress|expand|align|unalign|eslint|biome|languages|init|dev|codemod|grounding|brief|orchestrate|simulate|pack author)(\s|$)/;

const SELECTOR_VERBS = ['tests missing', 'tests impact', 'owners impact', 'impact', 'knowledge search', 'templates search', 'paths search'];

describe('r75 — §1.2#5: a required input selector omitted is a refusal, never a quiet 0', () => {
  test('every registered path whose usage requires a selector, invoked bare', async () => {
    const fx = consumerFixture();
    const registry = buildRegistry();
    // The usage-shape reading, plus the per-item query verbs that guard their
    // selector with `requireInputSelector` (a quoted or `|`-joined selector can
    // escape the shape reading, so they are always swept by name).
    const byShape = registry
      .listAll()
      .map(({ path, handler }) => path.join(' ') + (requiresSelector(handler.usage, path.join(' ')) ? '' : '\0'))
      .filter((p) => !p.endsWith('\0') && !SWEEP_SKIP.test(p));
    expect(byShape.length).toBeGreaterThan(80);
    const registered = new Set(registry.listAll().map(({ path }) => path.join(' ')));
    for (const verb of SELECTOR_VERBS) expect(registered.has(verb)).toBe(true);
    const required = [...new Set([...byShape, ...SELECTOR_VERBS])].map((path) => ({ path }));
    const prev = process.env.SHARKCRAFT_USAGE_DISABLED;
    process.env.SHARKCRAFT_USAGE_DISABLED = '1';
    const failures: string[] = [];
    try {
      for (const { path } of required) {
        const r = await runInProcess(['--cwd', fx, ...path.split(' ')]);
        if (r.code === 0) failures.push(`${path}: exit 0`);
        else if (r.code === 'timeout') failures.push(`${path}: never returned`);
        else if (`${r.out}${r.err}`.trim().length === 0) failures.push(`${path}: zero bytes`);
        if (SELECTOR_VERBS.includes(path) && (r.code !== ExitCode.UsageError || !r.err.includes('Usage:'))) {
          failures.push(`${path}: expected 3 + its usage line, got ${r.code}`);
        }
      }
    } finally {
      if (prev === undefined) delete process.env.SHARKCRAFT_USAGE_DISABLED;
      else process.env.SHARKCRAFT_USAGE_DISABLED = prev;
    }
    expect(failures).toEqual([]);
  }, 300_000);
});

describe('r75 — one authority each', () => {
  test('`gates try` is a registered verdict verb (a usage error there exits 3)', () => {
    expect(isGateVerb('gates try')).toBe(true);
    expect(usageExitFor('gates try')).toBe(ExitCode.UsageError);
    expect(usageExitFor('gates list')).toBe(ExitCode.NotVerified);
  });

  test('one did-you-mean scorer: no CLI source outside dispatch/closest-match.ts defines an edit distance', () => {
    const srcRoot = join(import.meta.dir, '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        if (statSync(abs).isDirectory()) {
          if (name !== '__tests__') walk(abs);
          continue;
        }
        if (!name.endsWith('.ts')) continue;
        const rel = relative(srcRoot, abs);
        if (rel === join('dispatch', 'closest-match.ts')) continue;
        const text = readFileSync(abs, 'utf8');
        if (/function\s+(editDistance|levenshtein)\b/i.test(text) || /Math\.floor\(\w+\.length\s*\/\s*4\)/.test(text)) {
          offenders.push(rel);
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});
