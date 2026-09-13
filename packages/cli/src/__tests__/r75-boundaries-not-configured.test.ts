/**
 * Round 11 (L-1) — zero boundary rules is NOT a clean check, and every surface
 * says so the same way.
 *
 * `check boundaries` over zero rules printed "No boundary rules configured.
 * Add `sharkcraft/boundaries.ts`…" and exited 0 — while that very file existed
 * (it simply was not listed in `boundaryFiles`). A typo'd `boundaryFiles` entry
 * was dropped silently. Quality said `passed`, finish said `skipped`, MCP gave a
 * count and no verdict. One authority (`describeBoundaryConfiguration`) now
 * explains the state; every surface reports "not verified".
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft, runDoctor } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '@shrkcrft/mcp-server';
import { checkCommand } from '../commands/check.command.ts';
import { boundariesSuggestCommand } from '../commands/boundaries.command.ts';
import { runFinishGates } from '../finish/run-finish.ts';
import { runQuality } from '../quality/run-quality.ts';
import { ExitCode } from '../exit-codes.ts';
import type { ParsedArgs } from '../command-registry.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');

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
): Promise<{ code: number; out: string; err: string }> {
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

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const RULES =
  "export default [{ id: 'core.no-ui', title: 'core no ui', severity: 'error', from: ['src/core/**'], forbiddenImports: ['@scope/ui'] }];\n";

function project(config: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-nocfg-'));
  roots.push(root);
  const all: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'fx'${config ? `, ${config}` : ''} };\n`,
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

/** boundaries.ts exists but is not listed — it loads nothing. */
const unlisted = (): string =>
  project('', { 'sharkcraft/boundaries.ts': RULES, 'src/core/x.ts': "import { B } from '@scope/ui';\n" });

describe('check boundaries over zero rules is NOT verified, and says why', () => {
  test('boundaries.ts present but unlisted → 2; the text names boundaryFiles; JSON says not-verified', async () => {
    const root = unlisted();
    const text = await run(checkCommand, args(root, ['boundaries']));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).toContain('is not listed in boundaryFiles');
    expect(text.out).toContain("boundaryFiles: ['boundaries.ts']");
    expect(text.out).toContain('NOT VERIFIED');
    const json = await run(checkCommand, args(root, ['boundaries'], { json: true }));
    const p = JSON.parse(json.out);
    expect(json.code).toBe(ExitCode.NotVerified);
    expect(p).toMatchObject({ verdict: 'not-verified', exitCode: 2, rules: 0 });
    expect(String(p.configuration.unlistedDefaultFile)).toEndWith(join('sharkcraft', 'boundaries.ts'));
    expect(p.gate.exit).toBe(2);
  });

  test("--allow-empty accepts the empty rule set explicitly (and says so)", async () => {
    const r = await run(checkCommand, args(unlisted(), ['boundaries'], { 'allow-empty': true }));
    expect(r.code).toBe(ExitCode.VerifiedPass);
    expect(r.out).toContain('accepted by --allow-empty');
  });

  test('global --strict promotes the 2 to 1 (from source)', () => {
    const root = unlisted();
    const res = spawnSync('bun', [CLI_MAIN, '--cwd', root, 'check', 'boundaries', '--strict'], { encoding: 'utf8' });
    expect(res.status).toBe(ExitCode.Failure);
  }, 90_000);

  test('boundaries suggest over zero rules is 2, never "nothing to suggest"', async () => {
    const r = await run(boundariesSuggestCommand, args(unlisted(), []));
    expect(r.code).toBe(ExitCode.NotVerified);
    expect(r.err).toContain('not listed in boundaryFiles');
  });
});

describe('a typo in boundaryFiles is loud', () => {
  test('runDoctor surfaces a warning naming the missing path, and check boundaries reports an errored rule (1)', async () => {
    const root = project("boundaryFiles: ['boundries.ts']", {
      'sharkcraft/boundaries.ts': RULES,
      'src/core/x.ts': 'export const x = 1;\n',
    });
    const inspection = await inspectSharkcraft({ cwd: root });
    expect(JSON.stringify(runDoctor(inspection).checks)).toContain('boundries.ts');
    const text = await run(checkCommand, args(root, ['boundaries']));
    expect(text.code).toBe(ExitCode.Failure);
    expect(text.out).toContain('listed rule file does not exist');
  });
});

describe('listed and valid still behaves (unchanged)', () => {
  test('exit 1 on a violation, 0 when clean', async () => {
    const dirty = project("boundaryFiles: ['boundaries.ts']", {
      'sharkcraft/boundaries.ts': RULES,
      'src/core/x.ts': "import { B } from '@scope/ui';\n",
    });
    expect((await run(checkCommand, args(dirty, ['boundaries']))).code).toBe(ExitCode.Failure);
    const clean = project("boundaryFiles: ['boundaries.ts']", {
      'sharkcraft/boundaries.ts': RULES,
      'src/core/x.ts': "import { D } from '@scope/data';\n",
    });
    expect((await run(checkCommand, args(clean, ['boundaries']))).code).toBe(ExitCode.VerifiedPass);
  });
});

describe('one zero-rule fixture — every surface agrees nothing was verified', () => {
  test('check boundaries (2), quality row (skipped), finish gate (skipped), MCP check_boundaries (not-verified)', async () => {
    const root = unlisted();
    expect((await run(checkCommand, args(root, ['boundaries']))).code).toBe(ExitCode.NotVerified);

    const inspection = await inspectSharkcraft({ cwd: root });
    const quality = await runQuality({
      inspection,
      config: {},
      strict: false,
      failFast: false,
      cwd: root,
      excludeDirs: [],
      gateRules: [],
    });
    const row = quality.items.find((i) => i.id === 'boundaries');
    expect(row?.status).toBe('skipped');
    expect(row?.skippedDeliberately).toBe(true);
    expect(row?.notes.join(' ')).toContain('not listed in boundaryFiles');

    const finish = await runFinishGates({
      cwd: root,
      mode: 'files',
      scope: { projectRoot: root, files: ['src/core/x.ts'] },
    });
    const gate = finish.gates.find((g) => g.name === 'boundaries');
    expect(gate?.status).toBe('skipped');
    expect(gate?.detail).toContain('not listed in boundaryFiles');

    const mcp = ALL_TOOLS.find((t) => t.name === 'check_boundaries')!;
    const data = (await mcp.handler({}, { inspection, cwd: root })).data as { verdict: string; exitCode: number };
    expect(data).toMatchObject({ verdict: 'not-verified', exitCode: 2 });
  });
});
