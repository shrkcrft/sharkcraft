/**
 * r75 — `check boundaries --diff-against` never prints its ✓ under a dead
 * candidate pattern (round 11 review R11-GAP-10).
 *
 * The main `check boundaries` path drops the ✓ at exit 0 and names the dead
 * selector units reported above it (`boundaryCleanSentence`). The
 * `--diff-against` path printed "• dead [forbidden] … typo or retired target?"
 * and, right under it, "Verdict: the candidate adds no error-severity
 * violation. ✓". It now uses the same dead-unit-aware clean line, and honours
 * `--fail-on-dead-units` like the main path.
 *
 * Real temp project, the real rule-file loader and command handler.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ParsedArgs } from '../command-registry.ts';
import { checkCommand } from '../commands/check.command.ts';
import { ExitCode } from '../exit-codes.ts';

const SLOW = 120_000;

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

/** Active: `src/app/**` must not import `@scope/ui`. Candidate: the same id, forbidding a package nothing imports. */
function project(): { root: string; candidate: string } {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-diff-dead-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx', boundaryFiles: ['boundaries.ts'] };\n",
    'sharkcraft/boundaries.ts':
      "export default [{ id: 'app.no-ui', title: 'app must not import ui', severity: 'error', from: ['src/app/**'], forbiddenImports: ['@scope/ui'] }];\n",
    'candidate-rules.ts':
      "export default [{ id: 'app.no-ui', title: 'app must not import ui', severity: 'error', from: ['src/app/**'], forbiddenImports: ['@scope/other'] }];\n",
    'src/app/a.ts': "import { B } from '@scope/ui';\nexport const a = B;\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return { root, candidate: join(root, 'candidate-rules.ts') };
}

describe('`check boundaries --diff-against` and a dead candidate pattern (R11-GAP-10)', () => {
  test('exit 0: the dead unit is reported and the verdict line names it — no ✓ under it', async () => {
    const { root, candidate } = project();
    const r = await run(checkCommand, args(root, ['boundaries'], { 'diff-against': candidate }));
    expect(r.code).toBe(ExitCode.VerifiedPass);
    expect(r.out).toContain('dead [forbidden] app.no-ui: @scope/other');
    expect(r.out).not.toContain('✓');
    const verdict = r.out.split('\n').find((l) => l.startsWith('Verdict:')) ?? '';
    expect(verdict).toContain('dead selector unit');
    expect(verdict).toContain('--fail-on-dead-units');
  }, SLOW);

  test('--fail-on-dead-units fails the candidate (1), as on the main path', async () => {
    const { root, candidate } = project();
    const r = await run(checkCommand, args(root, ['boundaries'], { 'diff-against': candidate, 'fail-on-dead-units': true }));
    expect(r.code).toBe(ExitCode.Failure);
    expect(r.out).toContain('dead selector unit(s) (--fail-on-dead-units)');
  }, SLOW);
});
