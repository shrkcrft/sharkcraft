/**
 * r77 — K6: a boundary rule accepted as intended-empty (every `from` inclusion
 * marked `expectEmpty`, no file matched) examined 0 files, so `check
 * boundaries` never counts it as evaluated — it prints it apart, `N evaluated,
 * M accepted as intended-empty`, and `--json` carries `rulesAcceptedEmpty`
 * beside `rulesEvaluated` (both from THE inspector counts). The CLI runs from
 * source over a real temp workspace.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const MAIN = join(import.meta.dir, '..', 'main.ts');
const T = 60_000;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function workspace(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r77-accepted-count-'));
  roots.push(root);
  const all: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx', boundaryFiles: ['boundaries.ts'] };\n",
    'src/app/a.ts': 'export const a = 1;\n',
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

function shrk(root: string, args: readonly string[]): { status: number | null; stdout: string } {
  const r = spawnSync(process.execPath, [MAIN, '--cwd', root, ...args], { encoding: 'utf8', timeout: T });
  return { status: r.status, stdout: r.stdout };
}

const RULES = `export default [
  { id: 'app.no-fs', title: 'app never imports fs', from: ['src/app/**'], forbiddenImports: ['node:fs'] },
  { id: 'plugins.no-fs', title: 'plugins never import fs', from: [{ pattern: 'src/plugins/**', expectEmpty: true }], forbiddenImports: ['node:fs'] },
];\n`;

describe('check boundaries — an accepted intended-empty rule is counted apart (K6)', () => {
  test(
    'text: `2 configured, 1 evaluated, 1 accepted as intended-empty`; --json: rulesEvaluated 1, rulesAcceptedEmpty 1',
    () => {
      const root = workspace({ 'sharkcraft/boundaries.ts': RULES });
      const text = shrk(root, ['check', 'boundaries']);
      expect(text.status).toBe(0);
      expect(text.stdout).toContain('2 configured, 1 evaluated, 1 accepted as intended-empty');
      expect(text.stdout).toContain('plugins.no-fs: accepted by expectEmpty');
      const json = JSON.parse(shrk(root, ['check', 'boundaries', '--json']).stdout) as {
        exitCode: number;
        rulesConfigured: number;
        rulesEvaluated: number;
        rulesAcceptedEmpty: number;
        coverage: readonly { ruleId: string; acceptedAsIntendedEmpty?: boolean }[];
      };
      expect(json.exitCode).toBe(0);
      expect([json.rulesConfigured, json.rulesEvaluated, json.rulesAcceptedEmpty]).toEqual([2, 1, 1]);
      expect(json.coverage.filter((c) => c.acceptedAsIntendedEmpty === true).map((c) => c.ruleId)).toEqual([
        'plugins.no-fs',
      ]);
    },
    T,
  );

  test(
    'control: with no planned rule the count line carries no accepted segment',
    () => {
      const root = workspace({
        'sharkcraft/boundaries.ts':
          "export default [{ id: 'app.no-fs', title: 'app never imports fs', from: ['src/app/**'], forbiddenImports: ['node:fs'] }];\n",
      });
      const text = shrk(root, ['check', 'boundaries']);
      expect(text.status).toBe(0);
      expect(text.stdout).toContain('1 configured, 1 evaluated');
      expect(text.stdout).not.toContain('accepted as intended-empty');
    },
    T,
  );
});
