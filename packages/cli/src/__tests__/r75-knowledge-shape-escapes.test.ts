/**
 * Round 11 §3.2 — shape escapes in knowledge references, end to end.
 *
 *  - A MALFORMED reference (a symbol with no `symbol`, a kind outside the
 *    vocabulary) used to be an `unknown` row next to `ok=2`, exit 0 — and a
 *    bogus kind crashed the whole stale-check. It is now `invalid`: counted,
 *    printed, and a coverage shortfall on the verdict (exit 2, never a pass);
 *    `--fail-on invalid` makes it a failure (1). A `url` stays `unknown` and
 *    never fails `--ci`.
 *  - An entry literal without `appliesWhen` no longer crashes `knowledge get`.
 *  - `--reference kind:value` parses every kind in the one vocabulary.
 *
 * Real workspaces, the real inspector, the real command handlers.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { KNOWLEDGE_REFERENCE_KINDS, validateKnowledgeEntries, type IKnowledgeEntry } from '@shrkcrft/knowledge';
import { parseReferenceSpec } from '../authoring/authoring-kit.ts';
import type { ParsedArgs } from '../command-registry.ts';
import { knowledgeGetCommand, knowledgeStaleCheckCommand } from '../commands/knowledge.command.ts';
import { ExitCode } from '../exit-codes.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function args(root: string, positional: string[] = [], flags: Record<string, string | boolean> = {}): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>([['cwd', root], ...Object.entries(flags)]),
    multiFlags: new Map(
      Object.entries(flags)
        .filter((kv): kv is [string, string] => typeof kv[1] === 'string')
        .map(([k, v]) => [k, [v]]),
    ),
  };
}

async function run(h: { run(a: ParsedArgs): Promise<number> | number }, a: ParsedArgs): Promise<{ code: number; out: string }> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = '';
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return { code: await h.run(a), out };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

function workspace(entries: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-kshape-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'src/a.ts': 'export const A = 1;\n',
    'sharkcraft/knowledge.ts': `export default [\n  ${entries.join(',\n  ')},\n];\n`,
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx', knowledgeFiles: ['knowledge.ts'] };\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const entry = (id: string, refs: string): string =>
  `{ id: '${id}', title: '${id}', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'About ${id}.', references: ${refs} }`;

/** k.url is verified (a file ref) and carries a url; k.bare omits every list field. */
const HEALTHY = [
  entry('k.url', "[{ kind: 'file', path: 'src/a.ts' }, { kind: 'url', id: 'https://example.com' }]"),
  "{ id: 'k.bare', title: 'Bare entry', type: 'technical', priority: 'medium', content: 'Bare.', references: [{ kind: 'file', path: 'src/a.ts' }] }",
];
/** k.refs: a symbol with no `symbol` + a leading-slash file + a valid file; k.bogus: a kind outside the vocabulary. */
const MALFORMED = [
  ...HEALTHY,
  entry('k.refs', "[{ kind: 'symbol', path: 'src/a.ts' }, { kind: 'file', path: '/src/a.ts' }, { kind: 'file', path: 'src/a.ts' }]"),
  entry('k.bogus', "[{ kind: 'file', path: 'src/a.ts' }, { kind: 'bogus-kind', path: 'x' }]"),
];

describe('stale-check — a malformed reference is invalid, never a green row', () => {
  test('default: invalid=2 is printed and the verdict is NOT VERIFIED (2) in text and JSON; no crash on a bogus kind', async () => {
    const root = workspace(MALFORMED);
    const t = await run(knowledgeStaleCheckCommand, args(root));
    expect(t.code).toBe(ExitCode.NotVerified);
    expect(t.out).toContain('invalid=2');
    expect(t.out).toContain('INVALID');
    expect(t.out).toContain('NOT VERIFIED');
    const j = await run(knowledgeStaleCheckCommand, args(root, [], { json: true }));
    const p = JSON.parse(j.out);
    expect([j.code, p.gate.exit]).toEqual([ExitCode.NotVerified, ExitCode.NotVerified]);
    expect(p.counts).toMatchObject({ invalid: 2, unknown: 1 });
    expect(p.failureCounts.malformed).toBe(2);
    const outcomes = (id: string): string[] =>
      p.referenceChecks.filter((c: { entryId: string }) => c.entryId === id).map((c: { outcome: string }) => c.outcome);
    expect(outcomes('k.refs')).toEqual(['invalid', 'ok', 'ok']);
    expect(outcomes('k.bogus')).toEqual(['ok', 'invalid']);
    expect(outcomes('k.url')).toEqual(['ok', 'unknown']);
    const rule = p.gate.rules[0];
    expect([rule.status, rule.coverage.unexaminedTotal]).toEqual(['partial', 2]);
  }, 60_000);

  test('--ci is not a pass over a malformed reference (non-zero); --fail-on invalid fails it (1)', async () => {
    const root = workspace(MALFORMED);
    expect((await run(knowledgeStaleCheckCommand, args(root, [], { ci: true }))).code).not.toBe(ExitCode.VerifiedPass);
    const failOn = await run(knowledgeStaleCheckCommand, args(root, [], { 'fail-on': 'invalid', json: true }));
    expect(failOn.code).toBe(ExitCode.Failure);
    const p = JSON.parse(failOn.out);
    expect(p.gate.rules[0].violations.some((v: { message: string }) => v.message.startsWith('MALFORMED'))).toBe(true);
  }, 60_000);

  test('a url reference stays unknown and never fails --ci', async () => {
    const r = await run(knowledgeStaleCheckCommand, args(workspace(HEALTHY), [], { ci: true }));
    expect(r.code).toBe(ExitCode.VerifiedPass);
  }, 60_000);
});

describe('knowledge get — an entry without appliesWhen renders', () => {
  test('exit 0, the entry printed', async () => {
    const r = await run(knowledgeGetCommand, args(workspace(HEALTHY), ['k.bare']));
    expect(r.code).toBe(ExitCode.VerifiedPass);
    expect(r.out).toContain('# Bare entry');
  }, 60_000);
});

describe('--reference kind:value parses the one vocabulary', () => {
  const value = (kind: string): string =>
    kind === 'file' ? 'src/a.ts' : kind === 'directory' ? 'src' : kind === 'symbol' ? 'A@src/a.ts' : 'some.id';

  test('every KNOWLEDGE_REFERENCE_KINDS member parses into a reference that validates clean', () => {
    for (const kind of KNOWLEDGE_REFERENCE_KINDS) {
      const ref = parseReferenceSpec(`${kind}:${value(kind)}`);
      expect({ kind, parsed: ref?.kind }).toEqual({ kind, parsed: kind });
      const e = {
        id: 'k.x', title: 'X', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'x',
        references: [ref],
      } as unknown as IKnowledgeEntry;
      const issues = validateKnowledgeEntries([e]).issues.filter((i) => i.code === 'invalid-reference');
      expect({ kind, issues }).toEqual({ kind, issues: [] });
    }
  });

  test('a kind outside the vocabulary does not parse', () => {
    expect(parseReferenceSpec('bogus-kind:x')).toBeNull();
  });
});
