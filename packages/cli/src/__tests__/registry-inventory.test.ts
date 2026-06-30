/**
 * `shrk registry <name> list | exists <id> | where <id>` — declarable registry
 * inventory (backlog 10.1). A project declares a registry in
 * `sharkcraft.config.ts registries[]` (reusing the wiring `{files,pattern}`
 * extractor); the verb answers exists/where against ground truth in one
 * deterministic multi-root scan. Self-contained temp project fixture.
 */
import { describe, expect, test, beforeAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

const CLI = nodePath.resolve(__dirname, '..', 'main.ts');

function shrk(args: readonly string[], cwd: string): { code: number; out: string; err: string } {
  const r = spawnSync('bun', [CLI, ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

describe('registry inventory verb', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(nodePath.join(tmpdir(), 'shrk-reg-inv-'));
    mkdirSync(nodePath.join(dir, 'sharkcraft'), { recursive: true });
    mkdirSync(nodePath.join(dir, 'src', 'commands'), { recursive: true });
    writeFileSync(nodePath.join(dir, 'package.json'), '{"name":"reg-inv","version":"0.0.0"}\n');
    writeFileSync(nodePath.join(dir, 'src', 'commands', 'a.command.ts'), "export const fooCommand = { name: 'foo' };\n");
    writeFileSync(nodePath.join(dir, 'src', 'commands', 'b.command.ts'), "export const barCommand = { name: 'bar' };\n");
    writeFileSync(
      nodePath.join(dir, 'sharkcraft', 'sharkcraft.config.ts'),
      `export default {\n  registries: [\n    { name: 'commands', source: { files: ['src/commands/*.command.ts'], pattern: "name:\\\\s*'([a-z]+)'" } },\n  ],\n};\n`,
    );
  });

  test('list enumerates declared ids', () => {
    const r = shrk(['registry', 'commands', 'list', '--json'], dir);
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.out);
    expect(payload.ids.sort()).toEqual(['bar', 'foo']);
  });

  test('exists is a hard yes/no with a distinguishable exit code', () => {
    expect(shrk(['registry', 'commands', 'exists', 'foo'], dir).code).toBe(0);
    expect(shrk(['registry', 'commands', 'exists', 'nope'], dir).code).toBe(1);
  });

  test('where returns the declaration site (path:line)', () => {
    const r = shrk(['registry', 'commands', 'where', 'foo', '--json'], dir);
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.out);
    expect(payload.found).toBe(true);
    expect(payload.entry.sites[0].file).toBe('src/commands/a.command.ts');
  });

  test('an unknown registry name errors (exit 2), does not silently pass', () => {
    const r = shrk(['registry', 'does-not-exist', 'list'], dir);
    expect(r.code).toBe(2);
  });

  test('lifecycle subverb still resolves', () => {
    const r = shrk(['registry', 'lifecycle', '--json'], dir);
    expect(r.code === 0 || r.code === 1).toBe(true);
  });
});
