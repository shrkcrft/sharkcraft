import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { detectGraphFreshness } from '@shrkcrft/graph';
import { buildCodeIntelligenceChecks, DoctorSeverity } from '@shrkcrft/inspector';
import { graphCommand } from '../commands/graph.command.ts';
import { codeIntelCommand } from '../commands/code-intel.command.ts';
import type { ParsedArgs } from '../command-registry.ts';

/**
 * ONE freshness authority.
 *
 * Two graph-derived surfaces answered "is the index current?" from different
 * evidence — `graph status` from working-tree divergence, `code-intel` from
 * wall-clock age — and gave contradictory verdicts on the same index in the
 * same second. The digest is the surface an inner-loop user or an agent skill
 * is pointed at, so the weaker signal was the one most people saw, and every
 * arch/cycle count derived from that index inherited the staleness unmarked.
 *
 * This asserts the two flip together, in both directions.
 */

const FIXTURE = resolve(import.meta.dir, '../../../../examples/gate-matrix-consumer');

let root: string;

function args(cwd: string, positional: string[], flags: Record<string, string | boolean> = {}): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>([['cwd', cwd], ...Object.entries(flags)]),
    multiFlags: new Map(),
  };
}

function capture(): () => string {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let body = '';
  const sink = ((c: string | Uint8Array): boolean => {
    body += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = sink;
  process.stderr.write = sink as typeof process.stderr.write;
  return () => {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    return body;
  };
}

async function run(h: { run(a: ParsedArgs): Promise<number> | number }, a: ParsedArgs) {
  const restore = capture();
  try {
    const code = await h.run(a);
    return { code, out: restore() };
  } catch (e) {
    restore();
    throw e;
  }
}

/** `graph status --json`'s divergence-based verdict. */
async function graphState(): Promise<string> {
  const { out } = await run(graphCommand, args(root, ['status'], { json: true }));
  return (JSON.parse(out) as { state: string }).state;
}

/** The digest's verdict for the same index, as one of the same three words. */
async function digestState(): Promise<'fresh' | 'stale' | 'not-verified'> {
  const { out } = await run(
    codeIntelCommand,
    args(root, [], { check: 'code-intelligence-graph' }),
  );
  if (/NOT VERIFIED/.test(out)) return 'not-verified';
  if (/Graph index STALE/.test(out)) return 'stale';
  if (/Graph index current/.test(out)) return 'fresh';
  throw new Error(`unrecognised digest verdict:\n${out}`);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'shrk-r74-'));
  cpSync(FIXTURE, root, { recursive: true });
  await run(graphCommand, args(root, ['index']));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the two surfaces cannot disagree', () => {
  test('index current, tree untouched → both say current', async () => {
    expect(await graphState()).toBe('fresh');
    expect(await digestState()).toBe('fresh');
  });

  test('modify ONE tracked, indexed file → both flip to stale', async () => {
    // The exact repro. Before the unification `graph status` said `stale` while
    // the digest said `fresh (1m ago)` — the index was a minute old, and age
    // was the only thing it looked at.
    appendFileSync(join(root, 'apps', 'barrel-consumer.ts'), '\n// r74 probe\n');
    expect(await graphState()).toBe('stale');
    expect(await digestState()).toBe('stale');
  });

  test('re-index → both return to current together', async () => {
    await run(graphCommand, args(root, ['index']));
    expect(await graphState()).toBe('fresh');
    expect(await digestState()).toBe('fresh');
  });

  test('a NEW untracked source file diverges too, on both surfaces', async () => {
    // Deliberate: a file the index has never seen is exactly the in-progress
    // state an inner-loop developer is in, and answering queries from an index
    // that cannot see it is how "no callers — safe to change" gets returned for
    // a symbol that has one.
    writeFileSync(join(root, 'apps', 'r74-new.ts'), 'export const R74 = 1;\n');
    expect(await graphState()).toBe('stale');
    expect(await digestState()).toBe('stale');
    rmSync(join(root, 'apps', 'r74-new.ts'));
  });
});

describe('age is a display detail, never the verdict', () => {
  test('an index built long ago with nothing changed since is CURRENT', () => {
    // The inversion that makes the point. The old check would have called this
    // stale purely because of the timestamp.
    const meta = join(root, '.sharkcraft', 'graph', 'meta.json');
    const parsed = JSON.parse(readFileSync(meta, 'utf8')) as { lastIndexedAt: string };
    const nowMs = Date.parse(parsed.lastIndexedAt) + 90 * 24 * 60 * 60 * 1000;
    const checks = buildCodeIntelligenceChecks(root, {
      nowMs,
      graphDivergence: detectGraphFreshness(root),
    });
    const graph = checks.find((c) => c.id === 'code-intelligence-graph')!;
    expect(graph.severity).toBe(DoctorSeverity.Ok);
    expect(graph.message).toMatch(/current \(indexed 90d ago\)/);
  });

  test('without a divergence measurement the digest refuses to call it fresh', () => {
    // The loud-skip half: an unmeasured verdict is not a pass.
    const checks = buildCodeIntelligenceChecks(root, {});
    const graph = checks.find((c) => c.id === 'code-intelligence-graph')!;
    expect(graph.severity).toBe(DoctorSeverity.Info);
    expect(graph.message).toMatch(/NOT VERIFIED/);
  });
});

describe('findings DERIVED from a stale index are not presented as counts', () => {
  test('the architecture delta is marked not-verified while the index is behind', () => {
    // The observed failure: a digest reported "1 new arch violation" from an
    // index missing 313 files; the true count after a real reindex was 6. The
    // same stale snapshot can equally report a violation already fixed.
    mkdirSync(join(root, '.sharkcraft', 'architecture'), { recursive: true });
    writeFileSync(
      join(root, '.sharkcraft', 'architecture', 'baseline.json'),
      JSON.stringify({ violationIds: [], countsBySeverity: { error: 0, warning: 0 } }),
    );
    writeFileSync(
      join(root, '.sharkcraft', 'architecture', 'last.json'),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        violationIds: ['v1'],
        countsBySeverity: { error: 1, warning: 0 },
      }),
    );

    const clean = buildCodeIntelligenceChecks(root, {
      graphDivergence: { hasIndex: true, modified: [], added: [], deleted: [] },
    });
    const counted = clean.find((c) => c.id === 'code-intelligence-architecture')!;
    expect(counted.message).toMatch(/1 new arch violation/);

    const behind = buildCodeIntelligenceChecks(root, {
      graphDivergence: { hasIndex: true, modified: ['apps/x.ts'], added: [], deleted: [] },
    });
    const skipped = behind.find((c) => c.id === 'code-intelligence-architecture')!;
    expect(skipped.message).toMatch(/NOT VERIFIED/);
    expect(skipped.message).not.toMatch(/1 new arch violation/);
  });
});
