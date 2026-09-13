/**
 * r75 — round 11 docs review: prose that described the CLI wrongly, and the
 * refusal messages that named the wrong thing. Every claim is checked against
 * the real registry, command index, changelog data and dispatcher — never a
 * copy of them.
 *
 *   DOC-1   exit-codes.md's graph bullet: an unknown flag on a graph subverb is
 *           refused before it runs — 3 on the verdict subverbs (`cycles`,
 *           `why`), 2 on the others — never `unknown option '--x'` at 2.
 *   DOC-4   command-discovery.md: `shrk help <command>` explains a command;
 *           `shrk explain` is the knowledge / rule topic search.
 *   DOC-6   the alpha.31 changelog names every path that became a verdict verb.
 *   DOC-7   surface-tiers.md no longer names the graph / api-diff subverbs as
 *           missing from the index — the index lists them.
 *   DOC-10  a retired `commands` subverb names its replacement, as the
 *           changelog now says (it promised a "closest match" nobody printed).
 *   DOC-11  a refusal names the flag as TYPED (`--x`, not `-x`), and `--offset
 *           -1` names the flag the number was meant for (not a flag `-1`).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandResolutionStatus } from '@shrkcrft/inspector';
import { misreadValueHint, parseArgs, spellFlagAsTyped, type ParsedArgs } from '../command-registry.ts';
import { RELEASE_SURFACE_DELTAS } from '../commands/changelog-data.ts';
import { registryLifecycleCommand } from '../commands/registry.command.ts';
import { ExitCode, GATE_VERB_PATHS, resetPipeHintLatch } from '../exit-codes.ts';
import { buildRegistry, runCli } from '../main.ts';
import { buildCommandIndex, setActiveCommandRegistry } from '../surface/command-index.ts';
import { resolveCommandString } from '../surface/resolve-command-string.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const TIMEOUT_MS = 240_000;

const roots: string[] = [];
afterAll(() => {
  setActiveCommandRegistry(undefined);
  // In-process verdict-verb refusals (exit 3 on a piped stdout) set the
  // process-lifetime pipe-hint latch: restore it for later files.
  resetPipeHintLatch();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

interface IRun {
  readonly code: number | 'timeout';
  readonly out: string;
  readonly err: string;
}

/** Capture stdout / stderr around `fn`. */
async function captured(fn: () => Promise<number> | number, timeoutMs = 120_000): Promise<IRun> {
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
      Promise.resolve(fn()),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
    ]);
    return { code, out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

/** The real dispatcher, in-process, rooted at this repository. */
function shrk(argv: readonly string[]): Promise<IRun> {
  return captured(() => runCli(['--cwd', REPO_ROOT, ...argv]));
}

function alpha31Text(): { readonly all: string; readonly removed: string } {
  const entry = RELEASE_SURFACE_DELTAS.find((d) => d.version === '0.1.0-alpha.31');
  expect(entry).toBeDefined();
  const added = entry?.added ?? [];
  const changed = entry?.changed ?? [];
  const removed = entry?.removed ?? [];
  return { all: [...added, ...changed, ...removed].join('\n'), removed: removed.join('\n') };
}

// ── DOC-1 ───────────────────────────────────────────────────────────────────

describe('DOC-1 — the graph bullet in exit-codes.md matches the dispatcher', () => {
  test('no `unknown option` / exit-2 promise for the whole family; the verdict subverbs are named', () => {
    const doc = read('docs/exit-codes.md');
    expect(doc).not.toContain("unknown option '--x'");
    expect(doc).toContain('`3` on the verdict subverbs (`graph cycles`, `graph why`)');
  });

  test(
    'an unknown flag is refused before the run: 3 on `graph cycles` / `graph why`, 2 on hubs / callers / impact / importers',
    async () => {
      const cases: readonly (readonly [readonly string[], number])[] = [
        [['graph', 'cycles', '--typo'], ExitCode.UsageError],
        [['graph', 'why', 'a', 'b', '--typo'], ExitCode.UsageError],
        [['graph', 'hubs', '--typo'], ExitCode.NotVerified],
        [['graph', 'callers', 'foo', '--typo'], ExitCode.NotVerified],
        [['graph', 'impact', '--typo'], ExitCode.NotVerified],
        [['graph', 'importers', 'foo', '--typo'], ExitCode.NotVerified],
      ];
      for (const [argv, code] of cases) {
        const r = await shrk(argv);
        const label = argv.join(' ');
        expect({ label, code: r.code }).toEqual({ label, code });
        expect(r.err).toContain('--typo');
        expect(r.err).not.toContain('unknown option');
        expect(r.out).toBe('');
      }
    },
    TIMEOUT_MS,
  );
});

// ── DOC-4 ───────────────────────────────────────────────────────────────────

describe('DOC-4 — the command explainer is `shrk help`, not `shrk explain`', () => {
  test('command-discovery.md says so, and the registry agrees', async () => {
    const doc = read('docs/command-discovery.md');
    expect(doc).not.toContain('folded into `shrk explain`');
    expect(doc).toContain('shrk help "<command>"');
    // `explain` takes a topic (the knowledge / rule search) …
    expect(buildRegistry().resolve(['explain']).handler?.usage).toContain('<topic>');
    // … and `help` describes a command.
    const help = await shrk(['help', 'check wiring']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('check wiring');
  }, TIMEOUT_MS);
});

// ── DOC-6 ───────────────────────────────────────────────────────────────────

/**
 * GATE_VERB_PATHS as released in 0.1.0-alpha.30 (read-only `git show
 * b3d2faa:packages/cli/src/exit-codes.ts`; round 10 left it unchanged).
 */
const ALPHA30_VERDICT_VERBS: readonly string[] = [
  'finish',
  'gate',
  'arch',
  'doctor',
  'diff-check',
  'check boundaries',
  'check wiring',
  'check orphans',
  'check policy',
  'check imports',
  'wiring unprovided',
  'wiring orphans',
  'wiring chain',
  'registry',
  'graph why',
  'graph cycles',
];

/** Every command path a backticked span names: `a b|c` → `a b`, `a c`; a leading `shrk ` is dropped. */
function namedPaths(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const tokens = (m[1] ?? '').trim().replace(/^shrk\s+/, '').split(/\s+/);
    const last = tokens.pop();
    if (last === undefined || last.length === 0) continue;
    for (const alt of last.split('|')) out.push([...tokens, alt].join(' '));
  }
  return out;
}

/** `by` names `path` itself or a verdict-verb prefix of it (an entry covers every deeper path). */
function covers(path: string, by: string): boolean {
  return path === by || path.startsWith(`${by} `);
}

describe('DOC-6 — the changelog names every newly registered verdict verb', () => {
  test('every GATE_VERB_PATHS entry alpha.30 did not cover is named in the alpha.31 entry', () => {
    const named = namedPaths(alpha31Text().all);
    const newlyVerdict = [...GATE_VERB_PATHS].filter((p) => !ALPHA30_VERDICT_VERBS.some((old) => covers(p, old)));
    expect(newlyVerdict.length).toBeGreaterThan(20);
    const unnamed = newlyVerdict.filter((p) => !named.some((n) => covers(p, n)));
    expect(unnamed).toEqual([]);
  });
});

// ── DOC-7 ───────────────────────────────────────────────────────────────────

describe('DOC-7 — the graph and api-diff subverbs are in the command index', () => {
  test('surface-tiers.md no longer names them as absent; the index lists them; a graph tail resolves ok', () => {
    const doc = read('docs/surface-tiers.md').replace(/\s+/g, ' ');
    expect(doc).not.toContain('the graph code-intelligence subverbs and the api-diff subverbs today');
    const index = buildCommandIndex(buildRegistry());
    const paths = new Set(index.entries.map((e) => e.path));
    for (const p of ['graph cycles', 'graph importers', 'graph why', 'api-diff capture']) {
      expect({ p, listed: paths.has(p) }).toEqual({ p, listed: true });
    }
    // A free `<assetId>` positional: a lookup, not an unknown subverb, never prefix-only.
    expect(resolveCommandString(index, 'shrk graph zzzq').status).toBe(CommandResolutionStatus.Ok);
  });
});

// ── DOC-10 ──────────────────────────────────────────────────────────────────

describe('DOC-10 — a retired `commands` subverb names its replacement', () => {
  test(
    '`commands suggest` → `commands search`, `commands explain` → `help <cmd>`; the changelog says what is printed',
    async () => {
      const suggest = await shrk(['commands', 'suggest', 'feed']);
      expect(suggest.code).toBe(ExitCode.NotVerified);
      expect(suggest.err).toContain('use `shrk commands search "<partial>"`');

      const explain = await shrk(['commands', 'explain', 'doctor']);
      expect(explain.code).toBe(ExitCode.NotVerified);
      expect(explain.err).toContain('use `shrk help <cmd>`');
      // It pointed at `shrk explain` — the topic search, not a command explainer.
      expect(explain.err).not.toContain('is a command of its own');

      expect(alpha31Text().removed).not.toContain('with the closest match');
    },
    TIMEOUT_MS,
  );
});

// ── DOC-11 ──────────────────────────────────────────────────────────────────

describe('DOC-11 — a refusal names the flag as typed', () => {
  test('the one spelling authority reads the argv parseArgs kept', () => {
    expect(parseArgs(['--x']).argv).toEqual(['--x']);
    expect(spellFlagAsTyped('x', ['--x'])).toBe('--x');
    expect(spellFlagAsTyped('x', ['--x=1'])).toBe('--x');
    expect(spellFlagAsTyped('x', ['-x'])).toBe('-x');
    expect(spellFlagAsTyped('x', undefined)).toBe('-x');
    expect(spellFlagAsTyped('json', undefined)).toBe('--json');
    expect(misreadValueHint('1', ['--offset', '-1'])).toContain('not as the value of --offset');
    expect(misreadValueHint('1', ['-1'])).toBeUndefined();
    expect(misreadValueHint('1', ['--offset=2', '-1'])).toBeUndefined();
    expect(misreadValueHint('x', ['--offset', '-x'])).toBeUndefined();
  });

  test(
    '`graph cycles --x` → 3 naming `--x` (it echoed `-x`); `check registry-lifecycle --offset -1` → 3 naming `--offset`',
    async () => {
      const cycles = await shrk(['graph', 'cycles', '--x']);
      expect(cycles.code).toBe(ExitCode.UsageError);
      expect(cycles.err).toContain('--x is not a flag of this command');

      const offset = await shrk(['check', 'registry-lifecycle', '--offset', '-1']);
      expect(offset.code).toBe(ExitCode.UsageError);
      expect(offset.err).toContain('-1 was read as a flag, not as the value of --offset');
      expect(offset.err).not.toContain('-1 is not a flag of this command');
      expect(offset.out).toBe('');
    },
    TIMEOUT_MS,
  );

  test('the lifecycle handler, called directly, reports the malformed VALUE (what intFlag promises)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-r75-docrev-offset-'));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
    const args: ParsedArgs = parseArgs(['--offset', '-1'], {
      globalCwd: root,
      ...(registryLifecycleCommand.booleanFlags ? { booleanFlags: registryLifecycleCommand.booleanFlags } : {}),
    });
    const r = await captured(() => registryLifecycleCommand.run(args));
    expect(r.code).toBe(ExitCode.UsageError);
    expect(r.err).toContain('--offset needs a non-negative integer (got "-1")');
    expect(r.err).not.toContain("unknown option '--1'");
  });
});
