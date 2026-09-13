/**
 * r77 — MCP `get_ci_prediction` never reads an unmeasured verdict as PASS
 * (round 13, lane P; facts-V3 "get_ci_prediction end to end").
 *
 * Reproduced end to end through the WRITER verb: `shrk self-config report`
 * (exit 2 — a scaffold pattern whose matchPaths match no file is a dead unit)
 * writes `.sharkcraft/reports/self-config-doctor.json` with verdict
 * `unverified`; the tool's `self` profile read it as `self-config verdict=pass`
 * — the reader mapped `errors` → fail, `warnings` → warn and EVERYTHING else to
 * pass. Now only `ok` is a pass, `unverified` predicts the CI step's failure,
 * an unknown verdict is `unknown`, and a report that carries its own non-zero
 * `exitCode` never reads as pass whatever field a probe keys on.
 *
 * The CLI is spawned from source; the tool is the real one from ALL_TOOLS.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '../tools/index.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const T = 120_000;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r77-ci-predict-'));
  roots.push(root);
  const all: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
    'src/a.ts': 'export const a = 1;\n',
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

interface IGate {
  readonly id: string;
  readonly verdict: string;
  readonly summary: string;
}

async function predict(root: string, profile: string): Promise<{ verdict: string; gates: readonly IGate[] }> {
  const tool = ALL_TOOLS.find((t) => t.name === 'get_ci_prediction');
  if (!tool) throw new Error('no get_ci_prediction tool');
  const inspection = await inspectSharkcraft({ cwd: root });
  return (await tool.handler({ profile }, { inspection, cwd: root })).data as { verdict: string; gates: readonly IGate[] };
}

describe('get_ci_prediction over an unverified self-config report', () => {
  test(
    'written by `self-config report` (exit 2): the self-config gate predicts FAIL, never pass',
    async () => {
      const root = workspace({
        'sharkcraft/scaffold-patterns.ts':
          "export default [\n  { id: 'sp.planned', title: 'Planned', description: 'd', templateId: 'tpl.x', kind: 'component', confidence: 'high', matchPaths: ['src/planned/**/*.ts'] },\n];\n",
      });
      const res = spawnSync('bun', ['run', CLI_MAIN, '--no-hints', 'self-config', 'report'], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
      expect(res.status).toBe(2);
      const written = JSON.parse(readFileSync(join(root, '.sharkcraft', 'reports', 'self-config-doctor.json'), 'utf8')) as {
        verdict: string;
      };
      expect(written.verdict).toBe('unverified');

      const report = await predict(root, 'self');
      const gate = report.gates.find((g) => g.id === 'self-config');
      expect(gate?.verdict).toBe('fail');
      expect(gate?.summary).toContain('unverified');
      expect(report.verdict).not.toBe('pass');
    },
    T,
  );

  test(
    'only `ok` is a pass; an unknown verdict is `unknown`; a report with a non-zero exitCode is never a pass',
    async () => {
      const root = workspace({});
      const reports = join(root, '.sharkcraft', 'reports');
      mkdirSync(reports, { recursive: true });
      const write = (name: string, value: unknown): void => writeFileSync(join(reports, name), JSON.stringify(value));

      write('self-config-doctor.json', { verdict: 'ok' });
      expect((await predict(root, 'self')).gates.find((g) => g.id === 'self-config')?.verdict).toBe('pass');

      write('self-config-doctor.json', { verdict: 'something-new' });
      expect((await predict(root, 'self')).gates.find((g) => g.id === 'self-config')?.verdict).toBe('unknown');

      // The CI scaffold writes `shrk self-config doctor --json`, which carries
      // its exit: `{"verdict":"ok", …, "exitCode": 2}` cannot be a pass.
      write('self-config-doctor.json', { verdict: 'ok', exitCode: 2 });
      const vetoed = (await predict(root, 'self')).gates.find((g) => g.id === 'self-config');
      expect(vetoed?.verdict).toBe('fail');
      expect(vetoed?.summary).toContain('NOT VERIFIED');

      // Nor a warn: `self-config doctor --strict --json` exits 1 on a warning.
      write('self-config-doctor.json', { verdict: 'warnings', exitCode: 1 });
      expect((await predict(root, 'self')).gates.find((g) => g.id === 'self-config')?.verdict).toBe('fail');
      write('self-config-doctor.json', { verdict: 'warnings', exitCode: 0 });
      expect((await predict(root, 'self')).gates.find((g) => g.id === 'self-config')?.verdict).toBe('warn');

      // The same guard over another probe: a doctor report with no errors but exit 2.
      write('doctor.json', { summary: { errors: 0 }, exitCode: 2 });
      expect((await predict(root, 'self')).gates.find((g) => g.id === 'doctor')?.verdict).toBe('fail');
      write('doctor.json', { summary: { errors: 0 }, exitCode: 0 });
      expect((await predict(root, 'self')).gates.find((g) => g.id === 'doctor')?.verdict).toBe('pass');
    },
    T,
  );
});
