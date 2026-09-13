/**
 * r75 — the registry-lifecycle size cap is a SHORTFALL, never a narrowing
 * (round 11 review OA-1).
 *
 * A file over the 256 KB lifecycle read cap was subtracted from the coverage's
 * `expected`, so a missing remover inside it settled to a clean "No missing
 * removers — … ✓" (exit 0) — the same file under the cap exits 1. The
 * boundaries reader's rule (over-cap = unread = a shortfall) is the one rule:
 * the file stays expected and is named unexamined, so both lifecycle verbs and
 * the MCP tool read NOT VERIFIED.
 *
 * Real temp projects; the real `check registry-lifecycle` / `registry
 * lifecycle` handlers and the registered MCP tool.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '@shrkcrft/mcp-server';
import type { ParsedArgs } from '../command-registry.ts';
import { checkCommand } from '../commands/check.command.ts';
import { registryCommand } from '../commands/registry.command.ts';
import { ExitCode } from '../exit-codes.ts';

const SLOW = 90_000;

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

const PAD_LINE = '// padding that pushes this file past the lifecycle read cap -----\n';

/** a.ts is symmetric; big.ts registers with NO matching remover, padded to `bytes`. */
function project(bytes: number): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-lifecap-'));
  roots.push(root);
  const big =
    'const m = new Map();\nexport function registerBig(id, x) { m.set(id, x); }\nexport function clearAll() { m.clear(); }\n';
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
    'src/a.ts':
      'const m = new Map();\nexport function registerA(id, x) { m.set(id, x); }\nexport function removeA(id) { m.delete(id); }\n',
    'src/big.ts': big + PAD_LINE.repeat(Math.ceil((bytes - big.length) / PAD_LINE.length)),
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

function tool(name: string): (typeof ALL_TOOLS)[number] {
  const t = ALL_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`MCP tool ${name} is not registered`);
  return t;
}

describe('registry lifecycle — a file over the read cap is unexamined, never excluded (OA-1)', () => {
  test('361 KB: both verbs 2 NOT VERIFIED naming big.ts (text + JSON); MCP not-verified', async () => {
    const root = project(361_000);
    expect(statSync(join(root, 'src/big.ts')).size).toBeGreaterThan(256 * 1024);

    const text = await run(checkCommand, args(root, ['registry-lifecycle']));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).not.toContain('✓');
    expect(text.out).toContain('src/big.ts');
    expect(text.out).toContain('NOT VERIFIED');

    const json = JSON.parse((await run(checkCommand, args(root, ['registry-lifecycle'], { json: true }))).out) as {
      exitCode: number;
      gate: { exit: number };
      coverage: { expected: number; examined: number; unexamined?: string[]; reason?: string };
      excludedFiles: { oversized: string[] };
    };
    expect({ exitCode: json.exitCode, gate: json.gate.exit }).toEqual({ exitCode: 2, gate: 2 });
    // big.ts stays EXPECTED (never subtracted) and is the one unexamined file.
    expect(json.coverage.expected - json.coverage.examined).toBe(1);
    expect(json.coverage.unexamined).toEqual(['src/big.ts']);
    expect(json.coverage.reason).toContain('256 KB lifecycle read cap');
    expect(json.excludedFiles.oversized).toEqual(['src/big.ts']);

    const verb = await run(registryCommand, args(root, ['lifecycle'], { json: true }));
    expect(verb.code).toBe(ExitCode.NotVerified);

    const inspection = await inspectSharkcraft({ cwd: root });
    const mcp = (await tool('get_registry_lifecycle_report').handler({}, { inspection, cwd: root })).data as {
      verdict: string;
    };
    expect(mcp.verdict).toBe('not-verified');
  }, SLOW);

  test('control: the same file UNDER the cap is judged — its missing remover fails (1)', async () => {
    const root = project(109_000);
    expect((await run(checkCommand, args(root, ['registry-lifecycle']))).code).toBe(ExitCode.Failure);
  }, SLOW);
});
