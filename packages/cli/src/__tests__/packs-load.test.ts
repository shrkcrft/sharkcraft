import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');

function shrk(args: readonly string[], cwd: string) {
  const res = spawnSync('bun', ['run', CLI_MAIN, ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout?.toString() ?? '',
    stderr: res.stderr?.toString() ?? '',
  };
}

function scaffoldPack(parent: string, kind: string): string {
  // Scaffolder refuses to write into an existing directory; let it create it.
  const root = join(parent, `pack-${kind}`);
  const r = shrk(['--cwd', parent, 'packs', 'new', `pack-${kind}`, '--kind', kind, '--write'], parent);
  if (r.status !== 0) {
    process.stderr.write(`packs new failed: ${r.stderr}\n`);
  }
  expect(r.status).toBe(0);
  return root;
}

describe('shrk packs test --load', () => {
  test('valid scaffolded pack passes --load', () => {
    const parent = mkdtempSync(join(tmpdir(), 'shrk-packs-load-ok-'));
    const pack = scaffoldPack(parent, 'architecture');
    const r = shrk(['packs', 'test', pack, '--load', '--json'], parent);
    const out = JSON.parse(r.stdout) as {
      passed: boolean;
      modules: { kind: string; loaded: boolean }[];
      issues: { code: string; severity: string }[];
    };
    expect(out.passed).toBe(true);
    expect(out.modules.length).toBeGreaterThan(0);
    expect(out.modules.some((m) => m.kind === 'plugin-entry' && m.loaded)).toBe(true);
  });

  test('broken default export is reported as an error', () => {
    const parent = mkdtempSync(join(tmpdir(), 'shrk-packs-load-bad-'));
    const pack = scaffoldPack(parent, 'generic');
    // Replace rules.ts with something that does not default-export an array.
    writeFileSync(join(pack, 'src/assets/rules.ts'), 'export default { not: "an array" };\n');
    const r = shrk(['packs', 'test', pack, '--load', '--json'], parent);
    const out = JSON.parse(r.stdout) as {
      passed: boolean;
      issues: { code: string; severity: string; message: string }[];
    };
    expect(out.passed).toBe(false);
    expect(out.issues.some((i) => i.code === 'asset-not-array')).toBe(true);
  });

  test('asset module that throws on import is reported', () => {
    const parent = mkdtempSync(join(tmpdir(), 'shrk-packs-load-throw-'));
    const pack = scaffoldPack(parent, 'generic');
    writeFileSync(join(pack, 'src/assets/templates.ts'), 'throw new Error("boom");\n');
    const r = shrk(['packs', 'test', pack, '--load', '--json'], parent);
    const out = JSON.parse(r.stdout) as {
      passed: boolean;
      issues: { code: string }[];
    };
    expect(out.passed).toBe(false);
    expect(out.issues.some((i) => i.code === 'asset-throw')).toBe(true);
  });

  test('--require-signature with no dist/manifest.json errors', () => {
    const parent = mkdtempSync(join(tmpdir(), 'shrk-packs-load-sig-'));
    const pack = scaffoldPack(parent, 'generic');
    const r = shrk(['packs', 'test', pack, '--require-signature', '--json'], parent);
    const out = JSON.parse(r.stdout) as {
      passed: boolean;
      issues: { code: string }[];
    };
    expect(out.passed).toBe(false);
    expect(out.issues.some((i) => i.code === 'missing-signature')).toBe(true);
  });
});
