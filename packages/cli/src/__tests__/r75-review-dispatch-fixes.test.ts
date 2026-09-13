/**
 * r75 — round 11 review, the dispatch group: one authority for "does this
 * command run?", and no verdict that answers it twice.
 *
 *   F1     `wiring unprovided|orphans|chain` with no `registrationGraph[]` examined
 *          nothing: 2 (text, JSON, the trailer), `--allow-empty` → 0 printed.
 *   F2     `check packs|templates` requested alone settle against their doctor's
 *          coverage: 2 over zero, like `packs doctor` / `templates doctor`.
 *   F3     an undocumented flag is refused BEFORE the body runs — `baseline
 *          update --dry-rn` wrote the ledger, then exited 3.
 *   CLI-1  the command-string resolver runs the dispatcher's own judgement: a
 *          string it certifies is one the dispatcher runs (property test).
 *   CLI-2  every verdict verb's declared walk reaches its verdict label, so a bad
 *          flag on `docs references check` is 3, labelled with its own path.
 *   CLI-3  one pre-dispatch strip: a leading `--compress` keeps `--exit-trailer`.
 *   CLI-4  a forwarding handler declares its flags: `smart-context --budgt` is 2.
 *   CLI-5  `review render-comment <v3> --boundaries b.json` is 0, not "ignored".
 *   CLI-9  a transposition is one edit; `graph statsu` names `graph status`.
 *   F4     `self-config broken-links` is a registered verdict verb (trailer, 3).
 *   TQ-1   no dead `session report` guidance.
 *   TQ-5   `baseline update`'s refusal survives a pipe, end to end.
 *
 * Real `buildRegistry()` and command index throughout; spawned from source
 * where the process boundary is the thing under test.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MAX_SCAN_FILE_BYTES } from '@shrkcrft/boundaries';
import { CommandResolutionStatus, levenshtein } from '@shrkcrft/inspector';
import {
  extractGlobalCompress,
  extractGlobalCwd,
  extractGlobalExitTrailer,
  parseArgs,
  type CommandRegistry,
  type ParsedArgs,
} from '../command-registry.ts';
import { checkCommand } from '../commands/check.command.ts';
import { graphCommand } from '../commands/graph.command.ts';
import { packsDoctorCommand } from '../commands/packs.command.ts';
import { smartContextCommand } from '../commands/smart-context.command.ts';
import { templatesDoctorCommand } from '../commands/templates.command.ts';
import { wiringCommand } from '../commands/wiring.command.ts';
import { editDistance } from '../dispatch/closest-match.ts';
import { PATH_TRANSPARENCY, stripPreDispatchGlobals } from '../dispatch/global-flags.ts';
import { guardInvocation } from '../dispatch/guard-invocation.ts';
import { wantsHelp } from '../dispatch/help-intercept.ts';
import type { IInvocationRejection } from '../dispatch/invocation-rejection.ts';
import { InvocationRejectionKind } from '../dispatch/invocation-rejection-kind.ts';
import { judgeInvocation } from '../dispatch/judge-invocation.ts';
import { walkDeclaredSubverbs } from '../dispatch/walk-declared-subverbs.ts';
import { ExitCode, GATE_VERB_PATHS, isGateVerb, resetPipeHintLatch, usageExitFor } from '../exit-codes.ts';
import { buildRegistry, runCli } from '../main.ts';
import { CommandDispatchKind } from '../surface/command-dispatch-kind.ts';
import { buildCommandIndex, setActiveCommandRegistry } from '../surface/command-index.ts';
import { resolveCommandString } from '../surface/resolve-command-string.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const SLOW = 180_000;

const roots: string[] = [];
afterAll(() => {
  setActiveCommandRegistry(undefined);
  // In-process runCli emits the once-per-process piped-exit note; release the
  // latch so a later file asserting that note is not order-dependent.
  resetPipeHintLatch();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

function git(root: string, ...a: string[]): void {
  spawnSync('git', ['-c', 'user.email=r75@test', '-c', 'user.name=r75', '-c', 'commit.gpgsign=false', ...a], { cwd: root });
}

/** A consumer repo; `config` is the body of its `sharkcraft.config.ts` default export. */
function fixture(config = "projectName: 'fx'", files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-dispatch-review-'));
  roots.push(root);
  write(root, 'package.json', JSON.stringify({ name: 'fx', version: '0.0.0' }));
  write(root, 'sharkcraft/sharkcraft.config.ts', `export default { ${config} };\n`);
  write(root, 'src/a.ts', 'export const a = 1;\n');
  for (const [rel, body] of Object.entries(files)) write(root, rel, body);
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'r75');
  return root;
}

function args(root: string, positional: string[], flags: Record<string, string | boolean> = {}): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>([['cwd', root], ...Object.entries(flags)]),
    multiFlags: new Map(),
  };
}

async function run(h: { run(a: ParsedArgs): Promise<number> | number }, a: ParsedArgs): Promise<{ code: number; out: string }> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = '';
  const sink = ((c: string | Uint8Array): boolean => {
    out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = sink;
  process.stderr.write = sink as typeof process.stderr.write;
  try {
    return { code: await h.run(a), out };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

async function runInProcess(argv: readonly string[]): Promise<{ code: number; out: string; err: string }> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const prev = process.env.SHARKCRAFT_USAGE_DISABLED;
  process.env.SHARKCRAFT_USAGE_DISABLED = '1';
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
    return { code: await runCli(argv), out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    resetPipeHintLatch();
    if (prev === undefined) delete process.env.SHARKCRAFT_USAGE_DISABLED;
    else process.env.SHARKCRAFT_USAGE_DISABLED = prev;
  }
}

function shrk(cwd: string, argv: readonly string[], env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('bun', [CLI_MAIN, ...argv], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, SHARKCRAFT_USAGE_DISABLED: '1', ...env },
    timeout: 150_000,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function lastLine(text: string): string {
  return text.trimEnd().split('\n').pop() ?? '';
}

/** THE dispatcher's pre-run judgement for a plain argv, descended exactly as `runCliInner` does. */
function dispatcherJudgement(
  registry: CommandRegistry,
  argv: readonly string[],
  cwd: string,
  index = buildCommandIndex(registry),
): { dispatched: boolean; rejection: IInvocationRejection | undefined } {
  const res = registry.resolve(stripPreDispatchGlobals(argv).rest, PATH_TRANSPARENCY);
  if (res.matchedPath.length === 0) return { dispatched: false, rejection: undefined };
  if (wantsHelp(res.rest)) return { dispatched: true, rejection: undefined };
  return {
    dispatched: true,
    rejection: judgeInvocation({
      registry,
      handler: res.handler,
      matchedPath: res.matchedPath,
      trieChildren: [...res.node.children.keys()],
      parsed: parseArgs(res.rest, res.handler?.booleanFlags ? { booleanFlags: res.handler.booleanFlags } : {}),
      cwd,
      index,
    }),
  };
}

// ── F1 ────────────────────────────────────────────────────────────────────────

describe('F1 — the registration-graph verdict verbs with no idioms examined nothing', () => {
  test('unprovided / orphans / chain: 2 in text and JSON; --allow-empty → 0 with the acceptance printed', async () => {
    const root = fixture();
    for (const sub of [['unprovided'], ['orphans'], ['chain', 'SOME_TOKEN']]) {
      const text = await run(wiringCommand, args(root, sub));
      expect({ sub: sub[0], code: text.code }).toEqual({ sub: sub[0], code: ExitCode.NotVerified });
      expect(text.out).toContain('NOT VERIFIED');
      expect(text.out).toContain('Pass --allow-empty');
      const json = JSON.parse((await run(wiringCommand, args(root, sub, { json: true }))).out) as {
        exitCode: number;
        verdict: string;
        shortfalls: string[];
      };
      expect({ sub: sub[0], exit: json.exitCode, verdict: json.verdict }).toEqual({ sub: sub[0], exit: 2, verdict: 'not-verified' });
      expect(json.shortfalls.join('\n')).toContain('no registrationGraph[] declared');
      const accepted = await run(wiringCommand, args(root, sub, { 'allow-empty': true }));
      expect({ sub: sub[0], code: accepted.code }).toEqual({ sub: sub[0], code: 0 });
      expect(accepted.out).toContain('accepted by --allow-empty');
    }
    // The planes agree: `check wiring` over the same empty config is 2 as well.
    expect((await run(checkCommand, args(root, ['wiring']))).code).toBe(ExitCode.NotVerified);
  }, SLOW);

  test('spawned: `wiring unprovided --exit-trailer` ends with `shrk-exit: 2`', () => {
    const r = shrk(fixture(), ['wiring', 'unprovided', '--exit-trailer']);
    expect(r.status).toBe(2);
    expect(lastLine(r.stderr)).toBe('shrk-exit: 2');
  }, SLOW);
});

// ── F2 ────────────────────────────────────────────────────────────────────────

describe('F2 — one answer to "are the packs / templates valid?" over zero of them', () => {
  test('`check packs` ≡ `packs doctor` and `check templates` ≡ `templates doctor`: 2 over zero; --allow-empty → 0', async () => {
    const root = fixture();
    expect((await run(packsDoctorCommand, args(root, []))).code).toBe(ExitCode.NotVerified);
    expect((await run(templatesDoctorCommand, args(root, []))).code).toBe(ExitCode.NotVerified);
    for (const group of ['packs', 'templates', 'knowledge', 'pipelines']) {
      const text = await run(checkCommand, args(root, [group]));
      expect({ group, code: text.code }).toEqual({ group, code: ExitCode.NotVerified });
      expect(text.out).toMatch(new RegExp(`SKIP +${group} `));
      expect(text.out).toContain('NOT VERIFIED');
      const json = JSON.parse((await run(checkCommand, args(root, [group], { json: true }))).out) as {
        exitCode: number;
        verdict: string;
      };
      expect({ group, exit: json.exitCode, verdict: json.verdict }).toEqual({ group, exit: 2, verdict: 'not-verified' });
      const accepted = await run(checkCommand, args(root, [group], { 'allow-empty': true }));
      expect({ group, code: accepted.code }).toEqual({ group, code: 0 });
      expect(accepted.out).toContain('accepted by --allow-empty');
    }
    // Bare `check` keeps the aggregate rule: an empty group is a deliberate skip.
    const bare = await run(checkCommand, args(root, []));
    expect(bare.code).toBe(ExitCode.VerifiedPass);
    expect(bare.out).toMatch(/SKIP +packs /);
  }, SLOW);

  test('`quality` reads the pack doctor verdict: zero packs is skipped, never passed', async () => {
    const root = fixture();
    const r = await runInProcess(['--cwd', root, 'quality', '--json']);
    const report = JSON.parse(r.out) as { gates?: { id: string; status: string }[]; items?: { id: string; status: string }[] };
    const packs = (report.gates ?? report.items ?? []).find((g) => g.id === 'packs');
    expect(packs?.status).toBe('skipped');
  }, SLOW);
});

// ── F3 ────────────────────────────────────────────────────────────────────────

describe('F3 — an undocumented flag is refused before anything runs', () => {
  const BASELINE =
    "baselines: [ { id: 'b', baseline: 'baselines/b.json', compute: { kind: 'extractor', source: { files: ['src/**/*.ts'], extract: 'export-names' } } } ]";

  test('spawned: `baseline update --dry-rn` writes nothing and exits 3, naming --dry-run; `--dry-run` still runs', () => {
    const root = fixture(`projectName: 'fx', ${BASELINE}`, { 'src/h.ts': 'export const A_H = 1;\nexport const B_H = 2;\n' });
    const typo = shrk(root, ['baseline', 'update', '--dry-rn']);
    expect(typo.status).toBe(usageExitFor('baseline update'));
    expect(typo.status).toBe(ExitCode.UsageError);
    expect(typo.stderr).toContain('--dry-rn is not a flag of this command');
    expect(typo.stderr).toContain('Did you mean --dry-run?');
    expect(typo.stdout).not.toContain('wrote');
    expect(existsSync(join(root, 'baselines'))).toBe(false);
    const real = shrk(root, ['baseline', 'update', '--dry-run']);
    expect(real.status).toBe(0);
    expect(real.stdout).toContain('would write baselines/b.json');
    expect(existsSync(join(root, 'baselines'))).toBe(false);
  }, SLOW);

  test('`check --tag auth` prints no sweep: refused before the body (3 on the verdict verb)', async () => {
    const r = await runInProcess(['--cwd', fixture(), 'check', '--tag', 'auth']);
    expect(r.code).toBe(ExitCode.UsageError);
    expect(r.err).toContain('--tag is not a flag of this command');
    expect(r.out).not.toContain('Check summary');
  }, SLOW);

  test('the refusal reads the same documentation the post-run detector does: ledger and documented flags pass', () => {
    const registry = buildRegistry();
    const root = REPO_ROOT;
    // A flag read behind a branch and listed in the ledger (`export --force`).
    expect(dispatcherJudgement(registry, ['export', 'claude-md', '--force'], root).rejection).toBeUndefined();
    // A documented flag, and a presentation flag (warned post-run, never refused).
    expect(dispatcherJudgement(registry, ['baseline', 'update', '--dry-run'], root).rejection).toBeUndefined();
    expect(dispatcherJudgement(registry, ['stats', '--verbose'], root).rejection).toBeUndefined();
    const bad = dispatcherJudgement(registry, ['baseline', 'update', '--zz-bogus'], root).rejection;
    expect(bad?.kind).toBe(InvocationRejectionKind.UnknownFlag);
    expect(bad?.exitCode).toBe(ExitCode.UsageError);
  });
});

// ── CLI-1 ─────────────────────────────────────────────────────────────────────

describe('CLI-1 — the resolver certifies exactly what the dispatcher runs', () => {
  const registry = buildRegistry();
  const index = buildCommandIndex(registry);
  const root = fixture();

  test('the review repros resolve to what the dispatcher does', () => {
    const cases: readonly (readonly [string, CommandResolutionStatus])[] = [
      ['shrk api-diff status', CommandResolutionStatus.UnknownSubverb],
      ['shrk compress stats', CommandResolutionStatus.UnknownSubverb],
      ['shrk contract check status', CommandResolutionStatus.UnknownSubverb],
      ['shrk feedback ingest notes', CommandResolutionStatus.UnknownSubverb],
      ['shrk review rendr', CommandResolutionStatus.UnknownSubverb],
      ['shrk apply latest', CommandResolutionStatus.UnknownSubverb],
      ['shrk gates check --chnged-only', CommandResolutionStatus.UnknownFlag],
      ['shrk graph cycles --typo', CommandResolutionStatus.UnknownFlag],
      ['shrk check boundaries --rulle x', CommandResolutionStatus.UnknownFlag],
      ['shrk docs references chek', CommandResolutionStatus.UnknownSubverb],
      ['shrk gates chek', CommandResolutionStatus.UnknownSubverb],
      ['shrk baseline chekc', CommandResolutionStatus.UnknownSubverb],
      // …and the real invocations stay certified.
      ['shrk gates check --changed-only', CommandResolutionStatus.Ok],
      ['shrk check boundaries --rule x', CommandResolutionStatus.Ok],
      ['shrk api-diff <baseline.json>', CommandResolutionStatus.Ok],
      ['shrk docs references check --json', CommandResolutionStatus.Ok],
      ['shrk check rules --help', CommandResolutionStatus.Ok],
      ['shrk --compress check wiring', CommandResolutionStatus.Ok],
    ];
    for (const [raw, want] of cases) {
      expect({ raw, status: resolveCommandString(index, raw, { root }).status }).toEqual({ raw, status: want });
    }
    // The closest real command rides along, from the dispatcher's own refusal.
    expect(resolveCommandString(index, 'shrk gates chek').closest).toContain('shrk gates check');
    expect(resolveCommandString(index, 'shrk gates check --chnged-only').closest).toContain('shrk gates check --changed-only');
  });

  test('a real file keeps a path-mode argument valid, exactly as the dispatcher reads it', () => {
    const withFile = fixture("projectName: 'fx'", { status: '{}\n' });
    expect(resolveCommandString(index, 'shrk api-diff status', { root: withFile }).status).toBe(CommandResolutionStatus.Ok);
    expect(dispatcherJudgement(registry, ['api-diff', 'status'], withFile).rejection).toBeUndefined();
  });

  test('property: over every indexed path, a bogus verb, a bogus flag and each documented flag — certified ⇔ dispatched', () => {
    const flagRe = /(?:^|[^A-Za-z0-9-])--([a-z0-9][a-z0-9-]*)/gi;
    const disagreements: string[] = [];
    let checked = 0;
    for (const e of index.entries) {
      if (e.dispatch === CommandDispatchKind.Meta) continue;
      if (registry.resolve(e.tokens).matchedPath.length === 0) continue;
      const flags = new Set([...(e.usage ?? '').matchAll(flagRe)].map((m) => m[1]!));
      const argvs: string[][] = [
        [...e.tokens],
        [...e.tokens, 'zz-bogus-verb'],
        [...e.tokens, '--zz-bogus-flag'],
        ...[...flags].map((f) => [...e.tokens, `--${f}`]),
        // Alias spellings dispatch like the name (`commands workflows`).
        ...e.aliases.map((a) => a.split(' ')),
      ];
      for (const argv of argvs) {
        const judged = dispatcherJudgement(registry, argv, root, index);
        if (!judged.dispatched) continue;
        checked += 1;
        const status = resolveCommandString(index, `shrk ${argv.join(' ')}`, { root }).status;
        const certified = status === CommandResolutionStatus.Ok || status === CommandResolutionStatus.PrefixOnly;
        if (certified !== (judged.rejection === undefined)) {
          disagreements.push(`shrk ${argv.join(' ')}: resolver ${status}, dispatcher ${judged.rejection ? 'refuses' : 'runs'}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(disagreements).toEqual([]);
  }, 120_000);
});

// ── CLI-2 ─────────────────────────────────────────────────────────────────────

describe('CLI-2 — every verdict verb is labelled as one by its declared walk', () => {
  test('for every GATE_VERB_PATHS entry, registry.resolve + walkDeclaredSubverbs lands on a verdict label', () => {
    const registry = buildRegistry();
    const failures: string[] = [];
    for (const path of GATE_VERB_PATHS) {
      const res = registry.resolve(path.split(' '));
      if (!res.handler) {
        failures.push(`${path}: no handler`);
        continue;
      }
      const walk = walkDeclaredSubverbs(res.handler, res.matchedPath, res.rest);
      if (!isGateVerb(walk.path.join(' '))) failures.push(`${path}: labelled \`${walk.path.join(' ')}\` (usage exit ${usageExitFor(walk.path.join(' '))})`);
    }
    expect(failures).toEqual([]);
  });

  test('a bad flag on `docs references check` / `registrations doctor` / `conventions doctor` is 3, labelled with the verb', () => {
    const registry = buildRegistry();
    for (const argv of [
      ['docs', 'references', 'check', '--bogus'],
      ['registrations', 'doctor', '--bogus'],
      ['conventions', 'doctor', '--bogus'],
      ['self-config', 'broken-links', '--bogus'],
    ]) {
      const label = argv.slice(0, -1).join(' ');
      const r = dispatcherJudgement(registry, argv, REPO_ROOT).rejection;
      expect({ label, exit: r?.exitCode }).toEqual({ label, exit: ExitCode.UsageError });
      expect(r?.message).toContain(`\`shrk ${label}\``);
    }
  });
});

// ── CLI-3 ─────────────────────────────────────────────────────────────────────

describe('CLI-3 — one pre-dispatch strip for the dispatcher and the verdict path', () => {
  test('stripPreDispatchGlobals ≡ the three extractors, in any order of the globals', () => {
    for (const argv of [
      ['--compress', 'check', 'wiring', '--exit-trailer'],
      ['--exit-trailer', '--ccr', 'gates', 'check'],
      ['--compress-type', 'text', 'check', 'wiring'],
      ['--cwd', 'x', '--compress', '--exit-trailer', 'doctor'],
    ]) {
      const chained = extractGlobalCompress(extractGlobalExitTrailer(extractGlobalCwd(argv).rest).rest).rest;
      expect({ argv, rest: stripPreDispatchGlobals(argv).rest }).toEqual({ argv, rest: chained });
    }
  });

  test('spawned: a leading `--compress` / `--ccr` keeps `--exit-trailer` on the verdict verb', () => {
    const root = fixture();
    for (const argv of [
      ['--compress', 'check', 'wiring', '--exit-trailer'],
      ['--exit-trailer', '--ccr', 'gates', 'check'],
    ]) {
      const r = shrk(root, argv);
      expect({ argv: argv.join(' '), trailer: lastLine(r.stderr) }).toEqual({ argv: argv.join(' '), trailer: `shrk-exit: ${r.status}` });
    }
  }, SLOW);
});

// ── CLI-4 ─────────────────────────────────────────────────────────────────────

describe('CLI-4 — a handler that forwards its argv is judged before it spawns', () => {
  test('every flag its usage documents is in the declared set', () => {
    const documented = [...smartContextCommand.usage.matchAll(/--([a-z0-9][a-z0-9-]*)/g)].map((m) => m[1]!);
    expect(documented.length).toBeGreaterThan(15);
    for (const f of documented) expect({ f, declared: smartContextCommand.flags?.has(f) }).toEqual({ f, declared: true });
  });

  test('spawned: `smart-context "x" --dry-run --budgt 5` → 2, naming --budget, and no prompt printed', () => {
    const r = shrk(fixture(), ['smart-context', 'add a thing', '--dry-run', '--budgt', '5'], {
      AI_PROVIDER: 'ollama',
      OLLAMA_HOST: 'http://127.0.0.1:9',
    });
    expect(r.status).toBe(usageExitFor('smart-context'));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('--budgt is not a flag of this command');
    expect(r.stderr).toContain('Did you mean --budget?');
    expect(r.stdout).toBe('');
  }, SLOW);
});

// ── CLI-5 ─────────────────────────────────────────────────────────────────────

describe('CLI-5 — a flag read only in some packet modes is documented, never "ignored"', () => {
  test('`review render-comment <v3 packet> --boundaries b.json` → 0; an unread-but-documented flag keeps the exit', async () => {
    const root = fixture();
    write(root, 'src/a.ts', 'export const a = 2;\n');
    const packet = await runInProcess(['--cwd', root, 'review', 'packet', '--v3', '--json']);
    expect(packet.code).toBe(0);
    expect(packet.out).toContain('sharkcraft.review-packet-v3');
    write(root, 'pv3.json', packet.out);
    write(root, 'b.json', '{}\n');
    const rendered = await runInProcess(['--cwd', root, 'review', 'render-comment', join(root, 'pv3.json'), '--boundaries', join(root, 'b.json')]);
    expect(rendered.code).toBe(0);
    expect(rendered.err).not.toContain('is not a flag of this command');
    const typo = await runInProcess(['--cwd', root, 'review', 'render-comment', join(root, 'pv3.json'), '--boundarys', 'b.json']);
    expect(typo.code).toBe(ExitCode.NotVerified);
    expect(typo.err).toContain('Did you mean --boundaries?');
  }, SLOW);
});

// ── CLI-9 ─────────────────────────────────────────────────────────────────────

describe('CLI-9 — a transposition is one edit, and a mistyped graph verb is named', () => {
  test('the one edit distance charges an adjacent swap 1 (and nothing else moved)', () => {
    expect(editDistance).toBe(levenshtein);
    for (const [a, b] of [['chian', 'chain'], ['lsit', 'list'], ['wirign', 'wiring'], ['explian', 'explain'], ['dney', 'deny'], ['chek', 'check']]) {
      expect({ a, b, d: editDistance(a!, b!) }).toEqual({ a, b, d: 1 });
    }
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('ab', 'ba')).toBe(1);
    expect(editDistance('abc', 'cba')).toBe(2);
  });

  test('`wiring chian foo` / `templates lsit` / `baseline chekc` name the closest subcommand', () => {
    const registry = buildRegistry();
    const guard = (argv: string[]): string => {
      const res = registry.resolve(argv, PATH_TRANSPARENCY);
      return (
        guardInvocation({
          registry,
          handler: res.handler,
          matchedPath: res.matchedPath,
          trieChildren: [...res.node.children.keys()],
          parsed: parseArgs(res.rest, res.handler?.booleanFlags ? { booleanFlags: res.handler.booleanFlags } : {}),
          cwd: REPO_ROOT,
        })?.message ?? ''
      );
    };
    expect(guard(['wiring', 'chian', 'foo'])).toContain('Did you mean `shrk wiring chain`?');
    expect(guard(['templates', 'lsit'])).toContain('Did you mean `shrk templates list`?');
    expect(guard(['baseline', 'chekc'])).toContain('Did you mean `shrk baseline check`?');
    expect(guard(['docs', 'references', 'chek'])).toContain('Did you mean `shrk docs references check`?');
  });

  test('`graph statsu` names `shrk graph status` and exits as a usage error, never the failure verdict 1', async () => {
    const root = fixture();
    const r = await run(graphCommand, args(root, ['statsu']));
    expect(r.code).toBe(usageExitFor('graph'));
    expect(r.out).toContain('Did you mean `shrk graph status`?');
    const miss = await run(graphCommand, args(root, ['no.such.node']));
    expect(miss.code).toBe(1);
    expect(miss.out).toContain('No graph node for "no.such.node"');
  }, SLOW);
});

// ── F4 ────────────────────────────────────────────────────────────────────────

describe('F4 — `self-config broken-links` is a registered verdict verb', () => {
  test('spawned: a broken seeAlso exits 1 with `shrk-exit: 1` as the last stderr line', () => {
    const root = fixture("projectName: 'fx', knowledgeFiles: ['knowledge.ts']", {
      'sharkcraft/knowledge.ts':
        "export default [{ id: 'k.one', title: 'One', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'About src/a.ts.', seeAlso: ['no.such.entry'] }];\n",
    });
    const r = shrk(root, ['self-config', 'broken-links', '--exit-trailer']);
    expect(r.status).toBe(1);
    expect(lastLine(r.stderr)).toBe('shrk-exit: 1');
    expect(isGateVerb('self-config broken-links')).toBe(true);
    expect(usageExitFor('self-config broken-links')).toBe(ExitCode.UsageError);
  }, SLOW);
});

// ── TQ-1 ──────────────────────────────────────────────────────────────────────

describe('TQ-1 — the legacy-session guidance names commands that run', () => {
  test('`dev status <id>` / `dev report <id>` resolve; `session report` never existed', () => {
    const index = buildCommandIndex(buildRegistry());
    expect(resolveCommandString(index, 'shrk dev status s-1').status).toBe(CommandResolutionStatus.Ok);
    expect(resolveCommandString(index, 'shrk dev report s-1').status).toBe(CommandResolutionStatus.Ok);
    expect(resolveCommandString(index, 'shrk session report').status).toBe(CommandResolutionStatus.UnknownVerb);
  });
});

// ── TQ-5 ──────────────────────────────────────────────────────────────────────

describe('TQ-5 — the bless step refusal survives a pipe, end to end', () => {
  test('spawned: `baseline update --exit-trailer` over an over-cap read → 2 and `shrk-exit: 2`, nothing blessed', () => {
    const root = fixture(
      "projectName: 'fx', baselines: [ { id: 'exports-ledger', baseline: 'exports.json', compute: { kind: 'extractor', source: { files: ['src/**/*.ts'], extract: 'export-names' } } } ]",
      {
        'exports.json': '["OLD"]\n',
        'src/big.ts': `export const BIG_T = 1;\n// ${'x'.repeat(MAX_SCAN_FILE_BYTES + 16)}\n`,
      },
    );
    const r = shrk(root, ['baseline', 'update', '--exit-trailer']);
    expect(r.status).toBe(ExitCode.NotVerified);
    expect(lastLine(r.stderr)).toBe('shrk-exit: 2');
    expect(r.stdout).toContain('NOT VERIFIED');
    expect(isGateVerb('baseline update')).toBe(true);
    expect(usageExitFor('baseline update')).toBe(ExitCode.UsageError);
  }, SLOW);
});
