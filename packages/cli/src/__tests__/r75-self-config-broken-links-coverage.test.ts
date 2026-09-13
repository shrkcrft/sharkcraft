/**
 * r75 — `self-config broken-links` always settles against what it examined
 * (round 11 review R11-GAP-4).
 *
 * It settled against NO coverage record whenever no declared cross-reference
 * id existed, so over an empty config (0 file references, 0 ids) it printed
 * "No broken references. ✓" at 0 — while its sibling doctors over the same
 * fixture were NOT VERIFIED (2). It now carries one `references` record (file
 * references + declared ids): nothing to examine is 2 unless `--allow-empty`
 * accepts it, printed.
 *
 * Real temp projects, the real handler, and one spawn through the real
 * dispatcher (the valve must be an accepted flag).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ParsedArgs } from '../command-registry.ts';
import { selfConfigBrokenLinksCommand } from '../commands/self-config.command.ts';
import { ExitCode } from '../exit-codes.ts';

const SLOW = 120_000;
const MAIN = join(import.meta.dir, '..', 'main.ts');

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
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-broken-links-'));
  roots.push(root);
  const all = { 'package.json': JSON.stringify({ name: 'efx', version: '0.0.0' }), ...files };
  for (const [rel, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

interface IBrokenLinksJson {
  exitCode: number;
  verdict: string;
  coverage: { unit: string; expected: number; examined: number };
  accepted: string[];
}

describe('`self-config broken-links` settles against what it examined (R11-GAP-4)', () => {
  test('nothing to examine: 2 in text and JSON, naming --allow-empty — never "No broken references. ✓"; the valve accepts it', async () => {
    const root = project({ 'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'efx' };\n" });
    const text = await run(selfConfigBrokenLinksCommand, args(root, []));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).not.toContain('✓');
    expect(text.out).toContain('NOT VERIFIED');
    expect(text.out).toContain('--allow-empty');

    const json = JSON.parse((await run(selfConfigBrokenLinksCommand, args(root, [], { json: true }))).out) as IBrokenLinksJson;
    expect({ exitCode: json.exitCode, verdict: json.verdict, coverage: json.coverage }).toEqual({
      exitCode: 2,
      verdict: 'not-verified',
      coverage: expect.objectContaining({ unit: 'references', expected: 0, examined: 0 }),
    });

    const accepted = await run(selfConfigBrokenLinksCommand, args(root, [], { 'allow-empty': true }));
    expect(accepted.code).toBe(ExitCode.VerifiedPass);
    expect(accepted.out).toContain('No broken references. ✓');

    // Through the real dispatcher: `--allow-empty` is an accepted flag here.
    const spawned = spawnSync('bun', [MAIN, 'self-config', 'broken-links', '--allow-empty', '--cwd', root], {
      encoding: 'utf8',
    });
    expect(spawned.status).toBe(0);
  }, SLOW);

  test('a file reference that resolves is examined: 0, coverage 1 of 1', async () => {
    const root = project({
      'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'efx', knowledgeFiles: ['knowledge.ts'] };\n",
      'sharkcraft/knowledge.ts':
        "export default [{ id: 'k.one', title: 'One', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'About src/a.ts.', references: [{ kind: 'file', path: 'src/a.ts' }] }];\n",
      'src/a.ts': 'export const a = 1;\n',
    });
    const json = JSON.parse((await run(selfConfigBrokenLinksCommand, args(root, [], { json: true }))).out) as IBrokenLinksJson;
    expect({ exitCode: json.exitCode, coverage: json.coverage }).toEqual({
      exitCode: 0,
      coverage: expect.objectContaining({ unit: 'references', expected: 1, examined: 1 }),
    });
  }, SLOW);
});
