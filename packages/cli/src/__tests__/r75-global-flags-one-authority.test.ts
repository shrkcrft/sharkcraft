/**
 * r75 — ONE authority for the dispatcher's global flags
 * (`dispatch/global-flags.ts`).
 *
 * Five places carried their own copy of the list: the guard's "Accepts:"
 * filter, the command-string resolver's strip sets, and the flag allow-lists
 * of `check boundaries`, `gates`, the lifecycle verbs and `reuse coverage`.
 * The resolver's copy had already drifted — it read `shrk --no-hints doctor`
 * as an unknown verb while the dispatcher ran `doctor`. Every consumer now
 * derives from the one list; these tests hold them to it behaviourally,
 * against the real registry and the real handlers.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { blankZoneKinds, lexCodeZones } from '@shrkcrft/boundaries';
import { CommandResolutionStatus } from '@shrkcrft/inspector';
import {
  extractGlobalCompress,
  extractGlobalCwd,
  extractGlobalExitTrailer,
  type ParsedArgs,
} from '../command-registry.ts';
import { checkCommand } from '../commands/check.command.ts';
import { reuseCoverageCommand } from '../commands/reuse-coverage.command.ts';
import { runRegistryLifecycle } from '../commands/registry-lifecycle-run.ts';
import {
  GLOBAL_FLAGS,
  GLOBAL_VALUE_FLAGS,
  IMPLICIT_FLAGS,
  PATH_TRANSPARENCY,
  STRIPPED_GLOBAL_FLAGS,
} from '../dispatch/global-flags.ts';
import { guardInvocation } from '../dispatch/guard-invocation.ts';
import { buildRegistry } from '../main.ts';
import { buildCommandIndex } from '../surface/command-index.ts';
import { resolveCommandString } from '../surface/resolve-command-string.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const registry = buildRegistry();
const index = buildCommandIndex(registry);

/** A global as typed: `-h`, `--cwd x`, `--no-hints`. */
function typed(flag: string): string[] {
  const dash = flag.length === 1 ? '-' : '--';
  return GLOBAL_VALUE_FLAGS.has(flag) ? [`${dash}${flag}`, 'x'] : [`${dash}${flag}`];
}

/** The pre-dispatch strip, as runCliInner chains it. */
function strip(argv: readonly string[]): string[] {
  return extractGlobalExitTrailer(extractGlobalCompress(extractGlobalCwd(argv).rest).rest).rest;
}

const HELP = new Set(['help', 'h']);

describe('the list itself', () => {
  test('value globals and implicit globals are drawn from GLOBAL_FLAGS; --strict is never implicit', () => {
    for (const f of GLOBAL_VALUE_FLAGS) expect({ f, global: GLOBAL_FLAGS.has(f) }).toEqual({ f, global: true });
    for (const f of IMPLICIT_FLAGS) expect({ f, global: GLOBAL_FLAGS.has(f) }).toEqual({ f, global: true });
    expect(IMPLICIT_FLAGS.has('strict')).toBe(false);
  });

  test('the runtime strippers remove EXACTLY the stripped globals — a value global with its value', () => {
    for (const f of GLOBAL_FLAGS) {
      const argv = ['doctor', ...typed(f), '--json'];
      const want = STRIPPED_GLOBAL_FLAGS.has(f) ? ['doctor', '--json'] : argv;
      expect({ f, out: strip(argv) }).toEqual({ f, out: want });
    }
    for (const f of GLOBAL_VALUE_FLAGS) {
      expect({ f, out: strip(['doctor', `--${f}=x`]) }).toEqual({ f, out: ['doctor'] });
    }
    // A command's own flag is never stripped.
    expect(strip(['doctor', '--json', '--verbose'])).toEqual(['doctor', '--json', '--verbose']);
  });
});

describe('the command-string resolver reads a global flag exactly as the dispatcher does', () => {
  test('a global before the verb, after it, or inside the path resolves the same command', () => {
    for (const f of GLOBAL_FLAGS) {
      const tok = typed(f).join(' ');
      const before = resolveCommandString(index, `shrk ${tok} doctor`);
      expect({ f, status: before.status }).toEqual({ f, status: CommandResolutionStatus.Ok });
      if (!HELP.has(f)) expect({ f, matched: before.matched }).toEqual({ f, matched: 'doctor' });
      const after = resolveCommandString(index, `shrk doctor ${tok}`);
      expect({ f, status: after.status, matched: after.matched }).toEqual({
        f,
        status: CommandResolutionStatus.Ok,
        matched: 'doctor',
      });
      if (HELP.has(f)) continue;
      const inside = resolveCommandString(index, `shrk scaffolds ${tok} list`);
      expect({ f, matched: inside.matched }).toEqual({ f, matched: 'scaffolds list' });
    }
  });

  test('the resolved path is the path the trie descent reaches over the stripped argv', () => {
    // Guard: each shape's clean path is reached through the trie itself.
    expect(registry.resolve(['scaffolds', 'list']).matchedPath).toEqual(['scaffolds', 'list']);
    const shapes: readonly (readonly string[])[] = [
      ['--no-hints', 'scaffolds', 'list'],
      ['scaffolds', '--no-hints', 'list'],
      ['--strict', 'doctor'],
      ['--cwd', 'x', '--exit-trailer', 'scaffolds', 'list'],
      ['--compress', '--ccr', 'doctor'],
      ['doctor', '--strict', 'warnings'],
    ];
    for (const argv of shapes) {
      const dispatched = registry.resolve(strip(argv), PATH_TRANSPARENCY).matchedPath.join(' ');
      const resolved = resolveCommandString(index, `shrk ${argv.join(' ')}`);
      expect({ argv, status: resolved.status, matched: resolved.matched }).toEqual({
        argv,
        status: CommandResolutionStatus.Ok,
        matched: dispatched,
      });
    }
  });

  test('a flag that is NOT global still stops the verb from dispatching', () => {
    expect(resolveCommandString(index, 'shrk --json doctor').status).toBe(CommandResolutionStatus.UnknownVerb);
  });
});

describe('the declared-flag guard and the in-body allow-lists accept every global', () => {
  function parsed(flags: Record<string, string | boolean>, positional: string[] = []): ParsedArgs {
    return { positional, flags: new Map(Object.entries(flags)), multiFlags: new Map() };
  }

  test('`gates check` (declared flags): every global passes the guard; "Accepts:" lists no implicit one', () => {
    const res = registry.resolve(['gates', 'check']);
    const input = {
      registry,
      handler: res.handler,
      matchedPath: res.matchedPath,
      trieChildren: [...res.node.children.keys()],
      cwd: REPO_ROOT,
    };
    for (const f of GLOBAL_FLAGS) {
      expect({ f, rejected: guardInvocation({ ...input, parsed: parsed({ [f]: true }) }) }).toEqual({
        f,
        rejected: undefined,
      });
    }
    const bad = guardInvocation({ ...input, parsed: parsed({ bogus: true }) });
    // Round 13: THE one refusal format; the declared set is its `Accepts:` line.
    expect(bad?.message).toContain('--bogus is not a flag of this command');
    expect(bad?.message).toContain('--strict');
    for (const f of IMPLICIT_FLAGS) {
      if (f.length > 1) expect({ f, listed: bad?.message.includes(`--${f},`) }).toEqual({ f, listed: false });
    }
  });

  async function stderrOf(runIt: () => Promise<number> | number): Promise<{ code: number; err: string }> {
    const orig = process.stderr.write.bind(process.stderr);
    const origOut = process.stdout.write.bind(process.stdout);
    let err = '';
    process.stderr.write = ((c: string | Uint8Array): boolean => {
      err += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = ((): boolean => true) as typeof process.stdout.write;
    try {
      return { code: await runIt(), err };
    } finally {
      process.stderr.write = orig;
      process.stdout.write = origOut;
    }
  }

  test('`check boundaries`, `reuse coverage` and the lifecycle verbs never call a global an unknown flag', async () => {
    for (const f of GLOBAL_FLAGS) {
      // Each call trips a LATER usage check, so the flag allow-list is the
      // only thing that could name the global.
      const boundaries = await stderrOf(() =>
        checkCommand.run(parsed({ [f]: true, rule: true }, ['boundaries'])),
      );
      expect({ f, err: boundaries.err.includes('is not a flag of this command') }).toEqual({ f, err: false });
      expect({ f, err: boundaries.err.includes('--rule needs a value') }).toEqual({ f, err: true });

      const reuse = await stderrOf(() => reuseCoverageCommand.run(parsed({ [f]: true }, ['stray'])));
      expect({ f, err: reuse.err.includes('is not a flag of this command') }).toEqual({ f, err: false });
      expect({ f, err: reuse.err.includes('takes no positional argument') }).toEqual({ f, err: true });

      const lifecycle = await stderrOf(() =>
        runRegistryLifecycle(parsed({ [f]: true, bogus: true }), 'check registry-lifecycle'),
      );
      expect({ f, err: lifecycle.err.includes(`unknown option '--${f}'`) }).toEqual({ f, err: false });
      expect({ f, err: lifecycle.err.includes("unknown option '--bogus'") }).toEqual({ f, err: true });
    }
  });
});

describe('no second copy of the list', () => {
  test('no CLI source outside dispatch/global-flags.ts spells a global flag name as a flag-set literal', () => {
    // `'no-hints'` / `'exit-trailer'` / `'compress-type'` / `'compress-query'`
    // (bare, as a flag Set stores them) are distinctive enough to find a copy;
    // the strippers spell the dashed argv form and are held to the list above.
    const srcRoot = join(REPO_ROOT, 'packages/cli/src');
    const copies: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        if (statSync(abs).isDirectory()) {
          if (name !== '__tests__' && name !== 'node_modules' && name !== 'dist') walk(abs);
          continue;
        }
        if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
        const rel = relative(srcRoot, abs);
        if (rel === join('dispatch', 'global-flags.ts')) continue;
        const raw = readFileSync(abs, 'utf8');
        const code = blankZoneKinds(raw, lexCodeZones(raw), new Set(['comment'] as const)).content;
        for (const m of code.matchAll(/['"](no-hints|exit-trailer|compress-type|compress-query)['"]/g)) {
          copies.push(`${rel}: '${m[1]}'`);
        }
      }
    };
    walk(srcRoot);
    expect(copies).toEqual([]);
  });
});
