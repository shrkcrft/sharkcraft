/**
 * r75 — two registered verdict verbs that printed a pass over NOTHING
 * (round 11 review R11-COV-6 / R11-COV-9).
 *
 *   - `arch check` with no code-graph store analyzed 0 files and printed "No
 *     violations." at exit 0, while the quality-gates arch gate said `skipped`
 *     and `gate baseline --refreeze` refused with 2 over the same diagnostic.
 *     One predicate (`archStoreMissing`) now; the verb settles 2.
 *   - bare `shrk check` printed `OK` over zero knowledge entries, templates,
 *     pipelines and packs. An empty group is `SKIP` (examined nothing) — a
 *     deliberate skip by default, NOT VERIFIED (2) under `--strict` —
 *     `shrk quality`'s aggregate rule.
 *
 * Real temp projects, the real config loader and inspector, the real handlers.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ParsedArgs } from '../command-registry.ts';
import { archCommand } from '../commands/arch.command.ts';
import { checkCommand } from '../commands/check.command.ts';
import { ExitCode } from '../exit-codes.ts';

const SLOW = 60_000;

function args(root: string, positional: string[], flags: Record<string, string | boolean> = {}): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>([['cwd', root], ...Object.entries(flags)]),
    multiFlags: new Map(),
  };
}

async function run(
  h: { run(a: ParsedArgs): Promise<number> | number },
  a: ParsedArgs,
): Promise<{ code: number; out: string }> {
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

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-nothing-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const MINIMAL = {
  'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
  'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
  'src/a.ts': 'export const a = 1;\n',
};

describe('`arch check` with no code-graph store is NOT VERIFIED (R11-COV-6)', () => {
  test('2 in text and JSON — never "No violations."', async () => {
    const root = project(MINIMAL);
    const text = await run(archCommand, args(root, ['check'], { 'no-persist': true }));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).not.toContain('No violations.');
    expect(text.out).toContain('NOT VERIFIED');
    expect(text.out).toContain('code-graph store missing');
    const json = JSON.parse((await run(archCommand, args(root, ['check'], { 'no-persist': true, json: true }))).out) as {
      exitCode: number;
      verdict: string;
      filesAnalyzed: number;
    };
    expect({ exitCode: json.exitCode, verdict: json.verdict, files: json.filesAnalyzed }).toEqual({
      exitCode: 2,
      verdict: 'not-verified',
      files: 0,
    });
  }, SLOW);
});

describe('bare `shrk check` never prints OK over a group that examined nothing (R11-COV-9)', () => {
  test('empty groups render SKIP (text) / skipped (JSON); a deliberate skip is still 0 by default', async () => {
    const root = project(MINIMAL);
    const text = await run(checkCommand, args(root, []));
    for (const group of ['knowledge', 'templates', 'pipelines', 'packs']) {
      expect(text.out).not.toMatch(new RegExp(`^ {2}OK +${group} `, 'm'));
      expect(text.out).toMatch(new RegExp(`^ {2}SKIP +${group} +errors=0 warnings=0 \\(examined nothing\\)$`, 'm'));
    }
    expect(text.code).toBe(ExitCode.VerifiedPass);
    const json = JSON.parse((await run(checkCommand, args(root, [], { json: true }))).out) as {
      exitCode: number;
      groups: { name: string; status: string }[];
    };
    const status = Object.fromEntries(json.groups.map((g) => [g.name, g.status]));
    expect({
      knowledge: status['knowledge'],
      templates: status['templates'],
      pipelines: status['pipelines'],
      packs: status['packs'],
    }).toEqual({ knowledge: 'skipped', templates: 'skipped', pipelines: 'skipped', packs: 'skipped' });
    expect(json.exitCode).toBe(ExitCode.VerifiedPass);
  }, SLOW);

  test('`--strict` makes an empty group required: NOT VERIFIED (2) in text and JSON, naming each group', async () => {
    // One real knowledge entry, so the doctor and the knowledge groups have
    // something to validate and raise no warning; templates / pipelines /
    // packs are empty.
    const root = project({
      ...MINIMAL,
      'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx', knowledgeFiles: ['knowledge.ts'] };\n",
      'sharkcraft/knowledge.ts':
        "export default [{ id: 'k.one', title: 'One', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'About src/a.ts.', references: [{ kind: 'file', path: 'src/a.ts' }] }];\n",
    });
    const text = await run(checkCommand, args(root, [], { strict: true }));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).toContain('NOT VERIFIED');
    const json = JSON.parse((await run(checkCommand, args(root, [], { strict: true, json: true }))).out) as {
      exitCode: number;
      verdict: string;
      shortfalls: string[];
    };
    expect({ exitCode: json.exitCode, verdict: json.verdict }).toEqual({ exitCode: 2, verdict: 'not-verified' });
    const named = json.shortfalls.map((s) => s.split(':')[0]).sort();
    expect(named).toEqual(['packs', 'pipelines', 'templates']);
    // Without --strict the same tree is a deliberate skip: 0.
    expect((await run(checkCommand, args(root, []))).code).toBe(ExitCode.VerifiedPass);
  }, SLOW);
});
