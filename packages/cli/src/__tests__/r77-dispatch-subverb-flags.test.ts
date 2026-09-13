/**
 * r77 — flags are documented per subverb, and a refused flag has ONE format
 * (round 13, lane P; facts-V3 "sibling subverbs silently accept …", facts-V2
 * "the unknown-flag refusal … comes in two formats").
 *
 *   - `check --fail-on-dead-units` ran the whole sweep at exit 0 — only `check
 *     boundaries` documents the flag; `self-config doctor --allow-empty` was
 *     accepted and ignored (only `self-config broken-links` documents it). The
 *     post-run judgement now reads the INVOCATION's documentation: a flag only a
 *     sibling documents that the run never read refuses a verdict verb's result
 *     (3, naming the sibling) and warns on an informational one. A flag the run
 *     READ is never judged — a group's shared option documented on one subverb
 *     is a real input of the others.
 *   - `gates check --x` printed `Unknown flag "--x" for \`shrk gates check\`.
 *     Accepts: …` while `policy-lint --x` printed `--x is not a flag of this
 *     command`; `check boundaries` kept a third format in its body. One builder
 *     words them all now.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CommandResolutionStatus } from '@shrkcrft/inspector';
import { parseArgs, type ParsedArgs } from '../command-registry.ts';
import { checkCommand } from '../commands/check.command.ts';
import { reuseCoverageCommand } from '../commands/reuse-coverage.command.ts';
import { InvocationRejectionKind } from '../dispatch/invocation-rejection-kind.ts';
import { judgeInvocation } from '../dispatch/judge-invocation.ts';
import { settleUnreadFlags } from '../dispatch/unread-flags.ts';
import { VerdictValveFlag } from '../dispatch/verdict-valve-flag.ts';
import { ExitCode, usageExitFor } from '../exit-codes.ts';
import { buildRegistry } from '../main.ts';
import { buildCommandIndex } from '../surface/command-index.ts';
import { resolveCommandString } from '../surface/resolve-command-string.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const T = 90_000;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r77-subverb-flags-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
    'src/a.ts': 'export const a = 1;\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

function shrk(cwd: string, argv: readonly string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('bun', ['run', CLI_MAIN, '--no-hints', ...argv], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** THE one format's first line for a refused flag. */
const FIRST_LINE = /^! `shrk [a-z -]+`: --[a-z-]+ is not a flag of this command/m;

describe('a flag only a sibling subverb documents is refused on the others', () => {
  test(
    '`check --fail-on-dead-units` (a verdict verb, a VALVE flag): refused BEFORE the sweep runs — 3, no output, naming `check boundaries` (K1)',
    () => {
      const r = shrk(workspace(), ['check', '--fail-on-dead-units']);
      expect(r.status).toBe(ExitCode.UsageError);
      expect(r.stderr).toContain(
        '`shrk check`: --fail-on-dead-units is not a flag of this command — only `shrk check boundaries` documents it',
      );
      // Round 13 (K1): a valve flag is judged before the run — the sweep never
      // prints a verdict over it (it used to print the whole sweep, then 3).
      expect(r.stderr).toContain('Refused before anything ran');
      expect(r.stdout).toBe('');
    },
    T,
  );

  test(
    '`self-config doctor --allow-empty`: 3, naming `self-config broken-links`',
    () => {
      const r = shrk(workspace(), ['self-config', 'doctor', '--allow-empty']);
      expect(r.status).toBe(ExitCode.UsageError);
      expect(r.stderr).toContain('--allow-empty is not a flag of this command — only `shrk self-config broken-links`');
    },
    T,
  );

  test(
    '`registrations list --fail-on-dead-units` (informational): refused before the run — the usage exit (it was warned and kept)',
    () => {
      const r = shrk(workspace(), ['registrations', 'list', '--fail-on-dead-units']);
      expect(r.status).toBe(usageExitFor('registrations list'));
      expect(r.status).not.toBe(ExitCode.VerifiedPass);
      expect(r.stderr).toContain('only `shrk registrations doctor` documents it');
      expect(r.stderr).toContain('Refused before anything ran');
      expect(r.stderr).not.toContain('(exit 0 kept)');
      expect(r.stdout).toBe('');
    },
    T,
  );

  test('K1 — the command-string resolver refuses the same valve strings, and certifies the documenting subverb', () => {
    const registry = buildRegistry();
    const index = buildCommandIndex(registry);
    const root = workspace();
    const refused = [
      'shrk check --fail-on-dead-units',
      'shrk check templates --fail-on-dead-units',
      'shrk registrations list --fail-on-dead-units',
      'shrk self-config doctor --allow-empty',
      'shrk self-config report --allow-empty',
    ];
    for (const raw of refused) {
      expect({ raw, status: resolveCommandString(index, raw, { root }).status }).toEqual({
        raw,
        status: CommandResolutionStatus.UnknownFlag,
      });
    }
    for (const raw of [
      'shrk check boundaries --fail-on-dead-units',
      'shrk registrations doctor --fail-on-dead-units',
      'shrk self-config broken-links --allow-empty',
      'shrk search --fail-on-dead-units tuning doctor',
      'shrk knowledge stale-check --min-referenced 50%',
      'shrk ci report --fail-on warning',
    ]) {
      expect({ raw, status: resolveCommandString(index, raw, { root }).status }).toEqual({
        raw,
        status: CommandResolutionStatus.Ok,
      });
    }
  });

  test('K1 — the pre-run judgement names every subverb that accepts the valve', () => {
    const registry = buildRegistry();
    const parsed = parseArgs(['--fail-on-dead-units']);
    const resolved = registry.resolve(['check']);
    const rejection = judgeInvocation({
      registry,
      handler: resolved.handler,
      matchedPath: resolved.matchedPath,
      trieChildren: [...resolved.node.children.keys()],
      parsed,
    });
    expect(rejection?.kind).toBe(InvocationRejectionKind.UnknownFlag);
    expect(rejection?.exitCode).toBe(usageExitFor('check'));
    expect(rejection?.message).toContain('only `shrk check boundaries` documents it');
    expect(rejection?.message).toContain('Refused before anything ran');
    // A flag that is no valve keeps the post-run judgement (a group's shared
    // option documented on one subverb may be read by all of them).
    expect(Object.values(VerdictValveFlag).map((v) => String(v)).sort()).toEqual(
      ['allow-empty', 'fail-on', 'fail-on-dead-units', 'min-referenced'],
    );
  });

  test(
    'control: the subverb that documents it is never judged (`check boundaries --fail-on-dead-units`)',
    () => {
      const r = shrk(workspace(), ['check', 'boundaries', '--fail-on-dead-units']);
      expect(r.stderr).not.toContain('is not a flag of this command');
      expect(r.status).not.toBe(ExitCode.UsageError);
    },
    T,
  );
});

describe('settleUnreadFlags — the post-run matrix', () => {
  const quiet = (): void => undefined;
  const group = ['shrk check boundaries [--fail-on-dead-units]', 'shrk check [--strict] [--json]'];
  const own = ['shrk check [--strict] [--json]'];
  const settle = (path: string, unread: string[], exit: number, groupDocs: readonly string[] | undefined = group): number =>
    settleUnreadFlags({
      unread,
      path,
      documentation: own,
      ...(groupDocs ? { groupDocumentation: groupDocs } : {}),
      exit,
      write: quiet,
    });

  test('a sibling-only flag on a verdict verb: 0 and 2 become the usage exit, a found 1 is kept', () => {
    expect(settle('check templates', ['fail-on-dead-units'], 0)).toBe(usageExitFor('check templates'));
    expect(settle('check templates', ['fail-on-dead-units'], 2)).toBe(usageExitFor('check templates'));
    expect(settle('check templates', ['fail-on-dead-units'], 1)).toBe(1);
  });

  test('a sibling-only flag on an informational verb: a 0 becomes the usage exit, a non-zero is kept', () => {
    expect(settle('registrations list', ['fail-on-dead-units'], 0)).toBe(usageExitFor('registrations list'));
    expect(usageExitFor('registrations list')).not.toBe(0);
    expect(settle('registrations list', ['fail-on-dead-units'], 1)).toBe(1);
  });

  test('a flag no documentation names (the backstop): a 0 becomes the usage exit, a non-zero is kept', () => {
    expect(settle('registrations list', ['zz-bogus'], 0)).toBe(usageExitFor('registrations list'));
    expect(settle('check templates', ['zz-bogus'], 2)).toBe(2);
  });

  test('a documented flag, a presentation flag, or nothing unread never changes the exit', () => {
    expect(settle('check templates', ['strict'], 0)).toBe(0);
    expect(settle('check templates', ['verbose'], 0, ['shrk check boundaries [--verbose]'])).toBe(0);
    expect(settle('check templates', [], 0)).toBe(0);
  });

  test('the message is THE one format, naming the sibling', () => {
    let text = '';
    settleUnreadFlags({
      unread: ['fail-on-dead-units'],
      path: 'check templates',
      documentation: own,
      groupDocumentation: group,
      documentedOn: () => ['check boundaries'],
      exit: 0,
      write: (s) => {
        text += s;
      },
    });
    expect(text).toMatch(FIRST_LINE);
    expect(text).toContain('— only `shrk check boundaries` documents it');
  });
});

describe('ONE refusal format — the guard, the documentation refusal and a verb’s own allow-list', () => {
  test(
    '`gates check --x` (a declared set) and `policy-lint --x` (documentation) print the same first line',
    () => {
      const root = workspace();
      const guard = shrk(root, ['gates', 'check', '--fail-on-dead-units']);
      expect(guard.status).toBe(ExitCode.UsageError);
      expect(guard.stderr).toMatch(FIRST_LINE);
      expect(guard.stderr).toContain('Accepts: ');
      expect(guard.stderr).toContain('Refused before anything ran');
      expect(guard.stderr).not.toContain('Unknown flag');

      const docs = shrk(root, ['policy-lint', '--fail-on-dead-units']);
      expect(docs.status).toBe(ExitCode.UsageError);
      expect(docs.stderr).toMatch(FIRST_LINE);
      expect(docs.stderr).toContain('Refused before anything ran');
    },
    T,
  );

  test('`check boundaries` / `reuse coverage` in-body allow-lists word it the same way', async () => {
    const root = workspace();
    const parsed = (flags: Record<string, string | boolean>, positional: string[]): ParsedArgs => ({
      positional,
      flags: new Map<string, string | boolean>([['cwd', root], ...Object.entries(flags)]),
      multiFlags: new Map(),
    });
    const capture = async (fn: () => Promise<number> | number): Promise<{ code: number; err: string }> => {
      const orig = process.stderr.write.bind(process.stderr);
      const origOut = process.stdout.write.bind(process.stdout);
      let err = '';
      process.stderr.write = ((c: string | Uint8Array): boolean => {
        err += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
        return true;
      }) as typeof process.stderr.write;
      process.stdout.write = ((): boolean => true) as typeof process.stdout.write;
      try {
        return { code: await fn(), err };
      } finally {
        process.stderr.write = orig;
        process.stdout.write = origOut;
      }
    };
    const boundaries = await capture(() => checkCommand.run(parsed({ rules: 'x.ts' }, ['boundaries'])));
    expect(boundaries.code).toBe(ExitCode.UsageError);
    expect(boundaries.err).toMatch(FIRST_LINE);
    expect(boundaries.err).toContain('Accepts: ');
    const reuse = await capture(() => reuseCoverageCommand.run(parsed({ bogus: true }, [])));
    expect(reuse.code).toBe(ExitCode.UsageError);
    expect(reuse.err).toMatch(FIRST_LINE);
  }, T);
});
