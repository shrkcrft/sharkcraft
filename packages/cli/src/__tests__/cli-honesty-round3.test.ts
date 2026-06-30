/**
 * CLI flag-honesty regressions, round 3 (cluster cli-honesty-3).
 *
 * Each test pins a "papercut" where a CLI silently accepted a typo'd filter
 * value and returned an empty result at exit 0, advertised a flag it never
 * read, mis-parsed a NaN flag, or broke `--json` on a no-match path:
 *
 *   CH3-1 — `shrk search "x" --kind <typo>` / `--source <typo>` were read
 *           unvalidated in the default v2 path; universal-search filtered
 *           every hit out → empty + exit 0. Both now reject (exit 2).
 *   CH3-2 — `shrk plan-context --budget abc` became NaN ("NaN tokens", 0
 *           files, exit 0). Now NaN-safe via flagPositiveInt (default 8000/30).
 *   CH3-3 — `shrk knowledge list|search --type <typo>` filtered silently.
 *           Now validated against the KnowledgeType vocabulary (exit 2).
 *   CH3-4 — `shrk graph --type <typo>` matched zero nodes silently. Now
 *           validated against KNOWN_KINDS (exit 2).
 *   CH3-5 — `shrk orchestrate|simulate --mode <typo>` was silently treated as
 *           balanced; now warns to stderr. Dead `--bundle`/`--session` usage
 *           tokens dropped.
 *   CH3-6 — `shrk paths best --task <miss> --json` emitted the human sentence
 *           instead of JSON. Now emits `{match:null}`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchCommand } from '../commands/search.command.ts';
import { planContextCommand } from '../commands/plan-context.command.ts';
import {
  knowledgeListCommand,
  knowledgeSearchCommand,
} from '../commands/knowledge.command.ts';
import { graphCommand } from '../commands/graph.command.ts';
import { orchestrateCommand } from '../commands/orchestrate.command.ts';
import { simulateCommand } from '../commands/simulate.command.ts';
import { pathsBestCommand } from '../commands/paths.command.ts';
import type { ParsedArgs } from '../command-registry.ts';

// A throwaway, near-empty workspace keeps every inspection cheap — none of
// these tests depend on real assets, only on the validation/parse behaviour.
const FIXTURE = mkdtempSync(join(tmpdir(), 'shrk-cli-honesty-r3-'));
writeFileSync(join(FIXTURE, 'package.json'), JSON.stringify({ name: 'demo' }, null, 2));
afterAll(() => rmSync(FIXTURE, { recursive: true, force: true }));

function makeArgs(opts: {
  positional?: string[];
  flags?: Record<string, string | boolean>;
  multi?: Record<string, string[]>;
}): ParsedArgs {
  return {
    positional: opts.positional ?? [],
    flags: new Map(Object.entries(opts.flags ?? {})),
    multiFlags: new Map(Object.entries(opts.multi ?? {})),
    globalCwd: FIXTURE,
  };
}

async function capture(
  fn: () => Promise<number> | number,
): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stdout.write = ((s: any) => ((out += String(s)), true)) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stderr.write = ((s: any) => ((err += String(s)), true)) as any;
  try {
    const code = await fn();
    return { code, out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

describe('shrk search --kind / --source (CH3-1)', () => {
  test('an unknown --kind exits 2, lists valid kinds, prints nothing', async () => {
    const r = await capture(() =>
      searchCommand.run(makeArgs({ positional: ['graph'], flags: { kind: 'bogusKind' } })),
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain('Unknown --kind bogusKind');
    expect(r.err).toContain('knowledge');
    expect(r.out).toBe('');
  });

  test('an unknown --source exits 2 and lists local/pack', async () => {
    const r = await capture(() =>
      searchCommand.run(makeArgs({ positional: ['graph'], flags: { source: 'remote' } })),
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain('Unknown --source remote');
    expect(r.err).toContain('local');
    expect(r.err).toContain('pack');
    expect(r.out).toBe('');
  });

  test('a valid --kind is accepted (exit 0)', async () => {
    const r = await capture(() =>
      searchCommand.run(
        makeArgs({ positional: ['graph'], flags: { kind: 'knowledge', json: true } }),
      ),
    );
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
  });
});

describe('shrk plan-context NaN budget (CH3-2)', () => {
  test('--budget abc falls back to the default 8000, exit 0', async () => {
    const r = await capture(() =>
      planContextCommand.run(
        makeArgs({ positional: ['tweak the alpha function'], flags: { budget: 'abc', json: true } }),
      ),
    );
    expect(r.code).toBe(0);
    const pack = JSON.parse(r.out) as { budget: { requested: number } };
    expect(pack.budget.requested).toBe(8000);
  });

  test('--max-files abc does not throw and still emits a valid pack', async () => {
    const r = await capture(() =>
      planContextCommand.run(
        makeArgs({
          positional: ['tweak the alpha function'],
          flags: { 'max-files': 'abc', json: true },
        }),
      ),
    );
    expect(r.code).toBe(0);
    const pack = JSON.parse(r.out) as { files: unknown[] };
    expect(Array.isArray(pack.files)).toBe(true);
  });
});

describe('shrk knowledge --type (CH3-3)', () => {
  test('list: an unknown --type exits 2 and lists the valid types', async () => {
    const r = await capture(() =>
      knowledgeListCommand.run(makeArgs({ multi: { type: ['bogusType'] } })),
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain('Unknown --type bogusType');
    expect(r.err).toContain('rule');
    expect(r.out).toBe('');
  });

  test('search: an unknown --type exits 2', async () => {
    const r = await capture(() =>
      knowledgeSearchCommand.run(
        makeArgs({ positional: ['anything'], multi: { type: ['bogusType'] } }),
      ),
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain('Unknown --type bogusType');
  });

  test('list: a valid --type is accepted (exit 0)', async () => {
    const r = await capture(() =>
      knowledgeListCommand.run(makeArgs({ multi: { type: ['rule'] }, flags: { json: true } })),
    );
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
  });
});

describe('shrk graph --type (CH3-4)', () => {
  test('an unknown --type exits 2 and lists KNOWN_KINDS', async () => {
    const r = await capture(() =>
      graphCommand.run(makeArgs({ flags: { type: 'bogusKind' } })),
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain('Unknown --type bogusKind');
    expect(r.err).toContain('knowledge');
    expect(r.out).toBe('');
  });

  test('a valid --type is accepted (exit 0)', async () => {
    const r = await capture(() =>
      graphCommand.run(makeArgs({ flags: { type: 'rule', json: true } })),
    );
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
  });
});

describe('shrk orchestrate / simulate --mode + dead flags (CH3-5)', () => {
  test('orchestrate usage no longer advertises --bundle / --session', () => {
    const usage = orchestrateCommand.usage ?? '';
    expect(usage).not.toContain('--bundle');
    expect(usage).not.toContain('--session');
  });

  test('simulate usage no longer advertises --bundle', () => {
    expect(simulateCommand.usage ?? '').not.toContain('--bundle');
  });

  test('orchestrate warns to stderr on an unknown --mode but still runs', async () => {
    const r = await capture(() =>
      orchestrateCommand.run(
        makeArgs({ positional: ['do a thing'], flags: { mode: 'turbo', json: true } }),
      ),
    );
    expect(r.code).toBe(0);
    expect(r.err).toContain('Unknown --mode turbo');
    expect(r.err).toContain('balanced');
  });

  test('simulate warns to stderr on an unknown --mode but still runs', async () => {
    const r = await capture(() =>
      simulateCommand.run(
        makeArgs({ positional: ['do a thing'], flags: { mode: 'turbo', json: true } }),
      ),
    );
    expect(r.code).toBe(0);
    expect(r.err).toContain('Unknown --mode turbo');
  });

  test('orchestrate accepts a valid --mode without warning', async () => {
    const r = await capture(() =>
      orchestrateCommand.run(
        makeArgs({ positional: ['do a thing'], flags: { mode: 'conservative', json: true } }),
      ),
    );
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
  });
});

describe('shrk paths best --json on a miss (CH3-6)', () => {
  test('a no-match --json miss emits parseable {match:null}, exit 0', async () => {
    const r = await capture(() =>
      pathsBestCommand.run(
        makeArgs({ flags: { task: 'zzz-no-convention-matches-this', json: true } }),
      ),
    );
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out) as { match: unknown };
    expect(parsed.match).toBeNull();
  });

  test('a no-match human (non-json) miss keeps the sentence', async () => {
    const r = await capture(() =>
      pathsBestCommand.run(makeArgs({ flags: { task: 'zzz-no-convention-matches-this' } })),
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain('No matching path convention.');
  });
});
