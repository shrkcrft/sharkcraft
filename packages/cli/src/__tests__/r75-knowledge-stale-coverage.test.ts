/**
 * Round 11, 1.1 — a corpus whose entries declare no references can never
 * report healthy.
 *
 * The staleness check walked each entry's declared references and folded an
 * entry with NONE into the healthy total: `entries=388 references=415 ok=415
 * stale=0`, exit 0, over a corpus checked a quarter of the way. The verdict now
 * has three buckets — verified / stale / unverifiable — and an unverifiable
 * entry is a coverage shortfall on the settled verdict: exit 2 unless an
 * explicit floor accepts it (`--min-referenced`).
 *
 * Every fixture is a real workspace loaded by the real config loader and
 * inspector, driven through the real command handler.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ParsedArgs } from '../command-registry.ts';
import { knowledgeStaleCheckCommand, knowledgeVerifyCommand } from '../commands/knowledge.command.ts';
import { ExitCode } from '../exit-codes.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** ParsedArgs exactly as `parseArgs` builds them: every string flag also lands in `multiFlags`. */
function args(root: string, flags: Record<string, string | boolean> = {}): ParsedArgs {
  return {
    positional: [],
    flags: new Map<string, string | boolean>([['cwd', root], ...Object.entries(flags)]),
    multiFlags: new Map(
      Object.entries(flags)
        .filter((kv): kv is [string, string] => typeof kv[1] === 'string')
        .map(([k, v]) => [k, [v]]),
    ),
  };
}

interface IRun {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function run(
  h: { run(a: ParsedArgs): Promise<number> | number },
  a: ParsedArgs,
): Promise<IRun> {
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
    return { code: await h.run(a), out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

/** One knowledge entry literal; `refs` is a JS array literal or omitted. */
function entry(id: string, refs?: string, type = 'technical'): string {
  return (
    `{ id: '${id}', title: '${id}', type: '${type}', priority: 'medium', scope: [], tags: [], ` +
    `appliesWhen: [], content: 'About ${id}.'${refs ? `, references: ${refs}` : ''} }`
  );
}

/** A real workspace: package.json, src files, sharkcraft/knowledge.ts and a config. */
function workspace(entries: readonly string[], extraFiles: Record<string, string> = {}, planes = ''): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-kcov-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'kfx', version: '0.0.0' }),
    'src/a.ts': 'export const A = 1;\n',
    'sharkcraft/knowledge.ts': `export default [\n  ${entries.join(',\n  ')}\n];\n`,
    'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'kfx', knowledgeFiles: ['knowledge.ts']${planes ? `, ${planes}` : ''} };\n`,
    ...extraFiles,
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const FILE_REF = "[{ kind: 'file', path: 'src/a.ts' }]";

/** The verdict line: the last non-empty line of the text output. */
function lastLine(out: string): string {
  const lines = out.split('\n').filter((l) => l.trim().length > 0);
  return lines[lines.length - 1] ?? '';
}

describe('an all-unreferenced corpus can never report healthy', () => {
  const zero = (): string => workspace(['a', 'b', 'c', 'd', 'e'].map((id) => entry(`k.${id}`)));

  test('the summary names the bucket and its share; the exit is 2 and the verdict never clean', async () => {
    const r = await run(knowledgeStaleCheckCommand, args(zero()));
    expect(r.code).toBe(ExitCode.NotVerified);
    expect(r.out).toContain('unverifiable: 5 (100%)');
    expect(r.out).toContain('NOT VERIFIED');
    expect(r.out).not.toContain('✓');
    // The verdict line never says clean / healthy / a bare "0 stale".
    expect(lastLine(r.out)).not.toMatch(/\bclean\b|\bhealthy\b|\b0 stale\b/i);
    // Every unverifiable id is listed, grouped by the file that declares it.
    expect(r.out).toContain('sharkcraft/knowledge.ts (5): k.a, k.b, k.c, k.d, k.e');
  }, 60_000);

  test('--json carries the buckets and a gate envelope with a SKIPPED rule — text exit == json exit', async () => {
    const root = zero();
    const r = await run(knowledgeStaleCheckCommand, args(root, { json: true }));
    const j = JSON.parse(r.out);
    expect(r.code).toBe(ExitCode.NotVerified);
    expect(j.exitCode).toBe(ExitCode.NotVerified);
    expect(j.coverage).toMatchObject({ entriesInScope: 5, verified: 0, stale: 0, unverifiable: 5, unverifiablePct: 100 });
    expect(j.unverifiableIds).toEqual(['k.a', 'k.b', 'k.c', 'k.d', 'k.e']);
    expect(j.gate.exit).toBe(ExitCode.NotVerified);
    expect(j.gate.verdict).toBe('not-verified');
    expect(j.gate.rules[0].type).toBe('knowledge');
    expect(j.gate.rules[0].status).toBe('skipped');
    expect(j.gate.rules[0].skipReason).toContain('no entry in scope declares a checkable reference');
    expect(j.gate.coverage).toMatchObject({ unit: 'knowledge entries', expected: 5, examined: 0 });
  }, 60_000);

  test('--min-referenced 0.5 fails it (1) with the ratio named', async () => {
    const r = await run(knowledgeStaleCheckCommand, args(zero(), { 'min-referenced': '0.5' }));
    expect(r.code).toBe(ExitCode.Failure);
    expect(r.out).toContain('reference coverage 0% < 50% (--min-referenced 0.5)');
  }, 60_000);

  test('--require-references fails it (1) and names every unverifiable entry', async () => {
    const r = await run(knowledgeStaleCheckCommand, args(zero(), { 'require-references': true, json: true }));
    const j = JSON.parse(r.out);
    expect(r.code).toBe(ExitCode.Failure);
    expect(j.gate.rules[0].status).toBe('failed');
    const unverifiable = j.gate.rules[0].violations.filter((v: { message: string }) => v.message.startsWith('UNVERIFIABLE'));
    expect(unverifiable.map((v: { id: string }) => v.id)).toEqual(['k.a', 'k.b', 'k.c', 'k.d', 'k.e']);
    expect(unverifiable[0].file).toBe('sharkcraft/knowledge.ts');
    // `--fail-on unverifiable` is the same switch.
    const alias = await run(knowledgeStaleCheckCommand, args(zero(), { 'fail-on': 'unverifiable' }));
    expect(alias.code).toBe(ExitCode.Failure);
  }, 60_000);
});

describe('a mixed 20 / 80 corpus', () => {
  const mixed = (): string =>
    workspace([
      entry('k.v1', FILE_REF),
      entry('k.v2', FILE_REF),
      ...['1', '2', '3', '4', '5', '6', '7', '8'].map((n) => entry(`k.u${n}`)),
    ]);

  test('exact buckets; strict default is 2 (never 0 over an unverifiable remainder)', async () => {
    const r = await run(knowledgeStaleCheckCommand, args(mixed(), { json: true }));
    const j = JSON.parse(r.out);
    expect(j.coverage).toMatchObject({ entriesInScope: 10, verified: 2, stale: 0, unverifiable: 8, unverifiablePct: 80 });
    expect(j.coverage.referencedRatio).toBeCloseTo(0.2, 5);
    expect(r.code).toBe(ExitCode.NotVerified);
    expect(j.gate.shortfalls[0]).toContain('examined 2 of 10 knowledge entries');
  }, 60_000);

  test('--min-referenced at the ratio ACCEPTS the remainder (0) and prints the acceptance', async () => {
    const r = await run(knowledgeStaleCheckCommand, args(mixed(), { 'min-referenced': '20%' }));
    expect(r.code).toBe(ExitCode.VerifiedPass);
    expect(r.out).toContain('2 of 10 knowledge entries verified');
    expect(r.out).toContain('accepted by --min-referenced 20%');
  }, 60_000);

  test('--min-referenced above the ratio fails (1)', async () => {
    const r = await run(knowledgeStaleCheckCommand, args(mixed(), { 'min-referenced': '0.5' }));
    expect(r.code).toBe(ExitCode.Failure);
  }, 60_000);

  test('the config floor (knowledgeCheck.minReferenced) accepts exactly like the flag, and says so', async () => {
    const root = workspace(
      [entry('k.v1', FILE_REF), entry('k.u1')],
      {},
      'knowledgeCheck: { minReferenced: 0.5 }',
    );
    const r = await run(knowledgeStaleCheckCommand, args(root));
    expect(r.code).toBe(ExitCode.VerifiedPass);
    expect(r.out).toContain('accepted by knowledgeCheck.minReferenced: 0.5');
  }, 60_000);

  test('a fully verified corpus is an earned 0', async () => {
    const r = await run(knowledgeStaleCheckCommand, args(workspace([entry('k.v1', FILE_REF)])));
    expect(r.code).toBe(ExitCode.VerifiedPass);
    expect(lastLine(r.out)).toBe('1 of 1 knowledge entry verified — no stale or missing references. ✓');
  }, 60_000);
});

describe('a malformed request is a usage error (3), never a verdict', () => {
  const root = (): string => workspace([entry('k.v1', FILE_REF)]);
  for (const [flag, value] of [
    ['fail-on', 'bogus'],
    ['min-referenced', 'abc'],
    ['min-referenced', '1.5'],
    ['stale-after', '3x'],
    ['as-of', '2026-13-01'],
    // A category / date with no --stale-after window can never fire — the
    // vacuous-category class, refused like `--fail-on bogus`.
    ['fail-on', 'aged'],
    ['as-of', '2026-01-01'],
  ] as const) {
    test(`--${flag} ${value}`, async () => {
      const r = await run(knowledgeStaleCheckCommand, args(root(), { [flag]: value }));
      expect(r.code).toBe(ExitCode.UsageError);
      expect(r.err).toContain('Usage: shrk knowledge stale-check');
    }, 60_000);
  }
});

describe('knowledge verify is the same verdict', () => {
  test('same exit, same buckets; the envelope names the verb that ran', async () => {
    const root = workspace([entry('k.v1', FILE_REF), entry('k.u1')]);
    const a = JSON.parse((await run(knowledgeStaleCheckCommand, args(root, { json: true }))).out);
    const vr = await run(knowledgeVerifyCommand, args(root, { json: true }));
    const b = JSON.parse(vr.out);
    expect(vr.code).toBe(a.exitCode);
    expect(b.coverage).toEqual(a.coverage);
    expect(a.gate.verb).toBe('knowledge stale-check');
    expect(b.gate.verb).toBe('knowledge verify');
  }, 60_000);
});

describe('4.3#4 — the sweep says which kinds it looked at', () => {
  test('per entry type, and boundary rules / policies that declare nothing say so in words', async () => {
    const root = workspace([
      entry('k.rule', FILE_REF, 'rule'),
      entry('k.path', undefined, 'path'),
      entry('k.tech', FILE_REF),
    ]);
    const r = await run(knowledgeStaleCheckCommand, args(root));
    expect(r.out).toMatch(/type:rule\s+1\s+0\s+1\s+1\s+0\s+0/);
    expect(r.out).toMatch(/type:path\s+1\s+1\s+0\s+0\s+0\s+1/);
    expect(r.out).toMatch(/boundary-rule\s+none declared/);
    expect(r.out).toMatch(/policy\s+none declared/);
    const j = JSON.parse((await run(knowledgeStaleCheckCommand, args(root, { json: true }))).out);
    expect(j.byEntryType.path).toMatchObject({ scanned: 1, zeroReferences: 1, unverifiable: 1 });
    expect(j.byReferenceKind.file).toMatchObject({ checked: 2, ok: 2 });
    expect(j.byAssetKind['boundary-rule'].scanned).toBe(0);
  }, 60_000);
});
