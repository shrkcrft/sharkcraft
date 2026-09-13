/**
 * Round 11 — `generated update` writes where `generated check` looks.
 *
 * `check` regenerates into a temp dir and aligns the output onto the committed
 * paths; `update` used to substitute `{TMP}` with the PROJECT ROOT instead. For
 * a flat regen such as this repo's own `schemas emit --out {TMP} --write`, the
 * documented remedy ("Re-emit with `shrk generated update --id json-schemas`")
 * therefore dumped every schema file at the repo root while `check` kept
 * comparing against docs/schemas/ — two code paths answering "where does the
 * output land", agreeing only by coincidence. These locks hold them to one.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const roots: string[] = [];

function shrk(root: string, args: readonly string[]): { status: number; stdout: string } {
  const res = spawnSync('bun', ['run', CLI_MAIN, '--cwd', root, ...args], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: res.status ?? -1, stdout: String(res.stdout ?? '') };
}

/**
 * A real project whose generator writes one FLAT file per source key into the
 * directory it is given — exactly the shape of `schemas emit --out {TMP}`.
 */
function fixture(source: Record<string, unknown>, committed: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-gen-update-'));
  roots.push(root);
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'out', 'gen'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'gen-fx', version: '0.0.0' }));
  writeFileSync(join(root, 'src', 'source.json'), JSON.stringify(source));
  writeFileSync(
    join(root, 'gen.ts'),
    [
      "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
      'const out = process.argv[2]!;',
      'mkdirSync(out, { recursive: true });',
      "const src = JSON.parse(readFileSync('src/source.json', 'utf8')) as Record<string, unknown>;",
      "for (const [k, v] of Object.entries(src)) writeFileSync(`${out}/${k}.json`, JSON.stringify(v) + '\\n');",
    ].join('\n'),
  );
  for (const [k, v] of Object.entries(committed)) {
    writeFileSync(join(root, 'out', 'gen', `${k}.json`), JSON.stringify(v) + '\n');
  }
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default {
  projectName: 'gen-fx',
  generatedArtifacts: [
    { id: 'gen', generatedGlob: ['out/gen/*.json'], regen: 'bun gen.ts {TMP}', compare: 'bytes', failOnEmpty: true },
  ],
};
`,
  );
  return root;
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe('generated update', () => {
  test('writes the regenerated files over their COMMITTED paths, never at the project root', () => {
    const root = fixture({ a: 1, b: 2 }, { a: 0, b: 2 });
    const res = shrk(root, ['generated', 'update', '--id', 'gen', '--json']);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as { inSync: boolean; results: { written: string[]; unchanged: string[] }[] };
    expect(out.inSync).toBe(true);
    expect(out.results[0]!.written).toEqual(['out/gen/a.json']);
    expect(out.results[0]!.unchanged).toEqual(['out/gen/b.json']);
    expect(readFileSync(join(root, 'out', 'gen', 'a.json'), 'utf8')).toBe('1\n');
    // The regression: a flat regen must not land at the project root.
    expect(readdirSync(root).filter((f) => f.endsWith('.json') && f !== 'package.json')).toEqual([]);
  });

  test('after update, check agrees the tree is in sync', () => {
    const root = fixture({ a: 1, b: 2 }, { a: 0, b: 2 });
    expect(shrk(root, ['generated', 'update', '--id', 'gen']).status).toBe(0);
    expect(shrk(root, ['generated', 'check', '--id', 'gen']).status).toBe(0);
  });

  test('a NEW output file is placed inside the rule glob, beside its siblings', () => {
    const root = fixture({ a: 1, c: 3 }, { a: 1 });
    const res = shrk(root, ['generated', 'update', '--id', 'gen', '--json']);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as { results: { created: string[] }[] };
    expect(out.results[0]!.created).toEqual(['out/gen/c.json']);
    expect(existsSync(join(root, 'out', 'gen', 'c.json'))).toBe(true);
    expect(existsSync(join(root, 'c.json'))).toBe(false);
  });

  test('a committed file the regen no longer produces is reported and KEPT, and the bless is not claimed', () => {
    const root = fixture({ a: 1 }, { a: 1, stale: 9 });
    const res = shrk(root, ['generated', 'update', '--id', 'gen', '--json']);
    // Not in sync: `check` would still report the stale file, so update must not exit 0.
    expect(res.status).toBe(1);
    const out = JSON.parse(res.stdout) as { inSync: boolean; results: { noLongerProduced: string[] }[] };
    expect(out.inSync).toBe(false);
    expect(out.results[0]!.noLongerProduced).toEqual(['out/gen/stale.json']);
    // Never deleted — removing a tracked file is a human decision.
    expect(existsSync(join(root, 'out', 'gen', 'stale.json'))).toBe(true);
    // Once the human removes it, check agrees.
    rmSync(join(root, 'out', 'gen', 'stale.json'));
    expect(shrk(root, ['generated', 'check', '--id', 'gen']).status).toBe(0);
  });
});
