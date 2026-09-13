/**
 * Round 11 review #1 — the zoned `regex-capture` per-file cap priced every
 * flagged hazard as if it crossed newlines. A LINE-BOUNDED pattern — even the
 * `[ \t]*` the hint itself recommended — over a 400-line doc comment was
 * "over budget" and skipped, so a wiring rule that passed before the cap
 * existed reported FAILED.
 *
 * Spawned from source over a real workspace with a real sharkcraft.config.ts:
 *   - the line-bounded declared pattern passes (0) and names no skip;
 *   - a newline-crossing lead over the same file is still bounded — the rule
 *     errors (never a silent pass) and `gates coverage` names the PREDICTED
 *     skip.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ExitCode } from '../exit-codes.ts';

const MAIN = resolve(import.meta.dir, '../main.ts');
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const DOC = '/**\n' + ' * lorem ipsum dolor sit amet consectetur adipiscing elit sed do\n'.repeat(400) + ' */\n';

function fixture(declaredPattern: string): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-zoned-wiring-'));
  roots.push(root);
  const write = (rel: string, body: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  const config = {
    projectName: 'fx',
    wiringRules: [
      {
        id: 'w-remedy',
        severity: 'error',
        declared: { files: ['src/decl.ts'], extract: 'regex-capture', pattern: declaredPattern, scan: 'code' },
        registered: { files: ['src/reg.ts'], pattern: 'registerThing\\((\\w+)\\)' },
      },
    ],
  };
  write('package.json', JSON.stringify({ name: 'fx', version: '0.0.0' }));
  write('sharkcraft/sharkcraft.config.ts', `export default ${JSON.stringify(config)};\n`);
  write('src/decl.ts', `${DOC}useThing(Foo);\n`);
  write('src/reg.ts', 'registerThing(Foo);\n');
  return root;
}

function shrk(root: string, ...argv: string[]): { code: number; out: string } {
  const r = spawnSync('bun', [MAIN, ...argv, '--cwd', root], { encoding: 'utf8', timeout: 90_000 });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('check wiring over a zoned declared pattern after a 400-line doc comment', () => {
  test('a line-bounded lead (`[ \\t]*useThing…`, the shape the hint once recommended) passes — never skipped', () => {
    const r = shrk(fixture('[ \\t]*useThing\\((\\w+)\\)'), 'check', 'wiring');
    expect({ code: r.code, out: r.out }).toMatchObject({ code: ExitCode.VerifiedPass });
    expect(r.out).not.toContain('over budget');
  }, 120_000);

  test('a newline-crossing lead (`\\s*useThing…`) is still bounded: the rule errors, and the skip is named as a prediction', () => {
    const root = fixture('\\s*useThing\\((\\w+)\\)');
    const r = shrk(root, 'check', 'wiring');
    expect({ code: r.code, out: r.out }).toMatchObject({ code: ExitCode.Failure });
    const cov = shrk(root, 'gates', 'coverage');
    expect(cov.out).toContain('predicted over budget, so the regex was never run');
  }, 120_000);
});
