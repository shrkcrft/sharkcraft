/**
 * r77 — `self-config report` is a verdict verb (round 13, lane A; DECISIONS §6).
 *
 * It settles THE self-config verdict (`--strict` and `--fail-on-dead-units`
 * honoured) and writes `.sharkcraft/reports/self-config-doctor.json` — the
 * file MCP `get_ci_prediction` reads — yet it was outside GATE_VERB_PATHS: a
 * bad flag exited 2, the same code as its own NOT VERIFIED; its help showed
 * `[--json]`, a flag it never read, and none of the flags it did. Plus the
 * `self-config doctor --json` vocabulary: `accepted` and the settled verdict.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isGateVerb, usageExitFor } from '../exit-codes.ts';

const CLI_MAIN = resolve(import.meta.dir, '..', 'main.ts');
const TIMEOUT_MS = 60_000;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function shrk(root: string, argv: readonly string[]): { readonly code: number; readonly out: string; readonly err: string } {
  const r = spawnSync('bun', [CLI_MAIN, '--cwd', root, '--no-hints', ...argv], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

function workspace(scaffoldMatchPaths: string): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r77-selfcfg-report-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
    'sharkcraft/scaffold-patterns.ts': `export default [{ id: 'fx.plugin', title: 'Plugin', description: 'd', templateId: 'fx.none', matchPaths: ${scaffoldMatchPaths}, variables: [], appliesWhen: ['infer-template'], confidence: 'high' }];\n`,
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

describe('r77 self-config report — a registered verdict verb', () => {
  test('it is in GATE_VERB_PATHS: a usage error is 3, never its own NOT VERIFIED 2', () => {
    expect(isGateVerb('self-config report')).toBe(true);
    expect(usageExitFor('self-config report')).toBe(3);
  });

  test(
    'a bad flag is refused (3) before anything is written; its help names the flags it reads',
    () => {
      const root = workspace("['src/retired/**/*.ts']");
      const bad = shrk(root, ['self-config', 'report', '--bogus-flag']);
      expect(bad.code).toBe(3);
      expect(existsSync(join(root, '.sharkcraft', 'reports', 'self-config-doctor.json'))).toBe(false);
      const help = shrk(root, ['self-config', 'report', '--help']);
      expect(help.code).toBe(0);
      for (const flag of ['--schema', '--output', '--strict', '--fail-on-dead-units', '--json']) {
        expect({ flag, documented: help.out.includes(flag) }).toEqual({ flag, documented: true });
      }
    },
    TIMEOUT_MS,
  );

  test(
    'it settles THE self-config verdict: a dead unit is 2, --fail-on-dead-units 1, and --json carries the settled fields',
    () => {
      const root = workspace("['src/retired/**/*.ts']");
      const plain = shrk(root, ['self-config', 'report', '--output', 'out']);
      expect(plain.code).toBe(2);
      expect(plain.out).toContain('NOT VERIFIED');
      expect(existsSync(join(root, 'out', 'self-config-doctor.json'))).toBe(true);
      expect(shrk(root, ['self-config', 'report', '--output', 'out', '--fail-on-dead-units']).code).toBe(1);
      const json = shrk(root, ['self-config', 'report', '--output', 'out', '--json']);
      expect(json.code).toBe(2);
      const body = JSON.parse(json.out) as {
        written: string[];
        exitCode: number;
        settledVerdict: string;
        shortfalls: string[];
        accepted: string[];
      };
      expect(body.exitCode).toBe(2);
      expect(body.settledVerdict).toBe('not-verified');
      expect(body.written).toContain(join('out', 'self-config-doctor.json'));
      expect(body.shortfalls.join('\n')).toContain('src/retired/**/*.ts');
      expect(body.accepted).toEqual([]);
      // Its 2 survives a pipe.
      expect(shrk(root, ['self-config', 'report', '--output', 'out', '--exit-trailer']).err).toContain('shrk-exit: 2');
    },
    TIMEOUT_MS,
  );

  test(
    'self-config doctor --json carries `accepted` and `settledVerdict` next to the report\'s own `verdict`',
    () => {
      const root = workspace("[{ pattern: 'src/plugins/*/plugin.ts', expectEmpty: true }]");
      const r = shrk(root, ['self-config', 'doctor', '--json']);
      const body = JSON.parse(r.out) as { exitCode: number; verdict: string; settledVerdict: string; accepted: string[] };
      expect(body.exitCode).toBe(r.code);
      // Unconditional (round 13 review): the CLI injects the command index, so
      // the marked fixture really settles 0 — a regression that dropped the
      // scaffold acceptance (0 → 2) must fail here, never skip the assertion.
      expect(r.code).toBe(0);
      expect(body.settledVerdict).toBe('pass');
      expect(['ok', 'warnings', 'errors', 'unverified']).toContain(body.verdict);
      expect(body.accepted.join('\n')).toContain('scaffold patterns: accepted by expectEmpty');
      const report = JSON.parse(shrk(root, ['self-config', 'report', '--json']).out) as { accepted: string[]; exitCode: number };
      expect(report.exitCode).toBe(r.code);
      expect(report.accepted).toEqual(body.accepted);
    },
    TIMEOUT_MS,
  );
});
