/**
 * Round 11 §1.4#a (6) — `packs release-check` was the ONE surface that caught a
 * pack's parse error, and it printed nothing and exited 0 from the consumer's
 * cwd: the pre-dispatch inspection imported the broken file first, and the
 * second import never settled. (The core import memo fixes the hang; this
 * locks the surface.) Spawned from source, from the consumer cwd.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const MAIN = resolve(import.meta.dir, '../main.ts');
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

describe('packs release-check from the consumer cwd', () => {
  test('a syntax-error contribution → exit 1 and contribution-load-failed on stdout', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-r75-relcheck-'));
    roots.push(root);
    write(root, 'package.json', JSON.stringify({ name: 'consumer', version: '0.0.0' }));
    write(root, 'sharkcraft/sharkcraft.config.ts', "export default { projectName: 'consumer' };\n");
    const pack = join(root, 'node_modules', '@r75', 'broken');
    write(pack, 'package.json', JSON.stringify({ name: '@r75/broken', version: '0.0.1', sharkcraft: { manifest: './manifest.json' }, files: ['.'] }));
    write(
      pack,
      'manifest.json',
      JSON.stringify({
        schema: 'sharkcraft.pack/v1',
        info: { name: '@r75/broken', version: '0.0.1' },
        contributions: { knowledgeFiles: ['./knowledge.ts'] },
      }),
    );
    write(pack, 'knowledge.ts', `export default [{ id: 'pack.broken', tags: ['a' 'b'] }];\n`);
    const r = spawnSync('bun', [MAIN, '--cwd', root, 'packs', 'release-check', 'node_modules/@r75/broken', '--json'], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('contribution-load-failed');
  });
});
