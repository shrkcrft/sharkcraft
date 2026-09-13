/**
 * r75 — every boundary consumer answers through THE boundary orchestrator
 * (round 11 review R11-GAP-3).
 *
 * The unread-file and zero-rule honesty reached only `runBoundaryCheck`. Eight
 * consumers still ran `scanImports` + `evaluateBoundaries` themselves: after
 * `chmod 000` on the file holding the violation, `check boundaries` said 2 while
 * `drift` and `architecture violations` said `total 0` at exit 0, and the
 * validation loop reported `boundaryViolations: 0` over zero rules. They now read
 * the orchestrator (a source lock holds it), and the verdict follows the gate.
 *
 * Real temp projects, the real inspector and command handlers.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { blankZoneKinds, lexCodeZones } from '@shrkcrft/boundaries';
import { evaluatePolicy, inspectSharkcraft } from '@shrkcrft/inspector';
import type { ParsedArgs } from '../command-registry.ts';
import { architectureViolationsCommand } from '../commands/architecture.command.ts';
import { driftCommand } from '../commands/drift.command.ts';
import { ExitCode } from '../exit-codes.ts';
import { runValidationLoop } from '../validation/run-validation-loop.ts';

const SLOW = 120_000;
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CANNOT_CHMOD =
  process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0);

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
const locked: string[] = [];
afterAll(() => {
  for (const f of locked) {
    try {
      chmodSync(f, 0o644);
    } catch {
      // already gone
    }
  }
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-one-boundary-'));
  roots.push(root);
  const all = { 'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }), ...files };
  for (const [rel, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

/** `src/app/**` must not import `@scope/ui`; a.ts does, b.ts is clean. */
function boundaryProject(): string {
  return project({
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx', boundaryFiles: ['boundaries.ts'] };\n",
    'sharkcraft/boundaries.ts':
      "export default [{ id: 'app.no-ui', title: 'app must not import ui', severity: 'error', from: ['src/app/**'], forbiddenImports: ['@scope/ui'] }];\n",
    'src/app/a.ts': "import { B } from '@scope/ui';\nexport const a = B;\n",
    'src/app/b.ts': 'export const b = 1;\n',
  });
}

function lock(root: string, rel: string): void {
  const abs = join(root, rel);
  chmodSync(abs, 0o000);
  locked.push(abs);
}

describe('the source lock: `evaluateBoundaries(` runs only inside the orchestrator (or over PLANNED edges)', () => {
  /** Each call site, with the reason it may call the engine directly. */
  const ALLOWED: Readonly<Record<string, string>> = {
    'packages/boundaries/src/evaluate/evaluate-boundaries.ts': 'the engine itself',
    'packages/inspector/src/run-boundary-check.ts': 'THE orchestrator (and its rule-set diff over one scan)',
    'packages/inspector/src/plan-review.ts': 'planned file contents are not on disk — evaluated over planned edges only',
    'packages/inspector/src/plan-simulation.ts': 'planned file contents are not on disk — evaluated over planned edges only',
  };

  test('no other non-test source calls it', () => {
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith('.ts')) {
          const text = readFileSync(p, 'utf8');
          const code = blankZoneKinds(text, lexCodeZones(text), new Set(['comment'] as const)).content;
          if (/\bevaluateBoundaries\(/.test(code)) callers.push(relative(REPO_ROOT, p).split('\\').join('/'));
        }
      }
    };
    walk(join(REPO_ROOT, 'packages'));
    expect(callers.sort()).toEqual(Object.keys(ALLOWED).sort());
  });
});

describe('drift / architecture violations / policy follow the gate over an unreadable governed file (R11-GAP-3)', () => {
  test('control: readable, both fail (1) on the violation', async () => {
    const root = boundaryProject();
    expect((await run(driftCommand, args(root, []))).code).toBe(ExitCode.Failure);
    expect((await run(architectureViolationsCommand, args(root, []))).code).toBe(ExitCode.Failure);
  }, SLOW);

  test.skipIf(CANNOT_CHMOD)('unreadable: drift and architecture violations are 2 in text and JSON — never `total 0` at 0', async () => {
    const root = boundaryProject();
    lock(root, 'src/app/a.ts');

    const driftText = await run(driftCommand, args(root, []));
    expect(driftText.code).toBe(ExitCode.NotVerified);
    expect(driftText.out).not.toContain('No drift detected');
    expect(driftText.out).toContain('src/app/a.ts');
    const driftJson = JSON.parse((await run(driftCommand, args(root, [], { json: true }))).out) as {
      exitCode: number;
      verdict: string;
      shortfalls: string[];
    };
    expect({ exitCode: driftJson.exitCode, verdict: driftJson.verdict }).toEqual({ exitCode: 2, verdict: 'not-verified' });

    const archText = await run(architectureViolationsCommand, args(root, []));
    expect(archText.code).toBe(ExitCode.NotVerified);
    expect(archText.out).toContain('NOT VERIFIED');
    const archJson = JSON.parse((await run(architectureViolationsCommand, args(root, [], { json: true }))).out) as {
      total: number;
      exitCode: number;
      verdict: string;
    };
    expect({ total: archJson.total, exitCode: archJson.exitCode, verdict: archJson.verdict }).toEqual({
      total: 0,
      exitCode: 2,
      verdict: 'not-verified',
    });

    const inspection = await inspectSharkcraft({ cwd: root });
    const policy = await evaluatePolicy(inspection);
    expect(policy.checks.some((c) => c.id === 'boundary:not-verified')).toBe(true);
  }, SLOW);
});

describe('zero boundary rules is never a clean boundary answer (R11-GAP-3)', () => {
  test('architecture violations → 2; the validation loop reports `boundaryVerdict: not-verified`, not a bare 0', async () => {
    const root = project({
      'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
      'src/a.ts': 'export const a = 1;\n',
    });
    expect((await run(architectureViolationsCommand, args(root, []))).code).toBe(ExitCode.NotVerified);
    const loop = await runValidationLoop({
      cwd: root,
      verificationIds: [],
      allVerifications: false,
      allowPackCommands: false,
      reportDir: null,
    });
    expect({ violations: loop.boundaryViolations, verdict: loop.boundaryVerdict }).toEqual({
      violations: 0,
      verdict: 'not-verified',
    });
    expect((loop.boundaryShortfalls ?? []).length).toBeGreaterThan(0);
  }, SLOW);
});
