/**
 * r75 — the self-config doctor's command probes (spec 3.5 / F-3.5#1).
 *
 * The doctor probed routing-hint commands and agent-test `expectedCommands`
 * against a set it initialised EMPTY ("the catalog lives in the CLI"), so a
 * correct `shrk doctor` was reported unregistered — at ERROR severity for an
 * agent test, failing the doctor with exit 1 — and was indistinguishable from
 * a genuinely dead `shrk no-such-verb`. The probes now go through the one
 * injected command resolver: exactly the dead command is flagged. Without a
 * resolver (a direct engine call, MCP) nothing is checked, and the report says
 * so once — never an error.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildSelfConfigDoctorReportV2,
  inspectSharkcraft,
  SelfConfigSeverityV2,
} from '@shrkcrft/inspector';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const SPAWN_TIMEOUT_MS = 120_000;

function shrk(cwd: string, argv: readonly string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('bun', ['run', CLI_MAIN, ...argv], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-cmdprobe-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'fx' };\n`,
    'sharkcraft/task-routing-hints.ts': `export default [
  {
    id: 'h.cmds',
    title: 'Command hint',
    match: { keywords: ['cmds'] },
    recommends: { commands: ['shrk doctor', 'shrk context --task "x"', 'shrk no-such-verb'] },
  },
];
`,
    'sharkcraft/agent-tests.ts': `export default [
  { id: 'at.cmd', task: 'check workspace health', expectedCommands: ['shrk doctor'] },
];
`,
  };
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

interface IDoctorJson {
  verdict: string;
  exitCode: number;
  findings: { code: string; severity: string; sourceKind: string; targetId: string }[];
  probes: { command: { probed: number; exists: number; unknown: number; unverified: number } };
}

describe('r75 — self-config doctor command probes', () => {
  test(
    'through the CLI: exactly the dead command is flagged, the correct ones are not, exit 0',
    () => {
      const root = fixture();
      try {
        const res = shrk(root, ['self-config', 'doctor', '--json']);
        const json = JSON.parse(res.stdout) as IDoctorJson;
        const commandFindings = json.findings.filter((f) => f.targetId.startsWith('shrk '));
        expect(commandFindings.map((f) => [f.code, f.severity, f.sourceKind, f.targetId])).toEqual([
          ['unknown-command', 'warning', 'routing-hint', 'shrk no-such-verb'],
        ]);
        // The empty-set false positives are gone, including the ERROR-severity
        // one that failed the doctor on a correct agent test.
        expect(json.findings.some((f) => f.code === 'routing-hint-command-missing')).toBe(false);
        expect(json.findings.some((f) => f.code === 'agent-test-command-missing')).toBe(false);
        expect(json.verdict).not.toBe('errors');
        // 4 from the fixture, plus the built-in presets / pipelines every
        // workspace loads — which must all resolve too (unknown is exactly 1).
        expect(json.probes.command).toMatchObject({ unknown: 1, unverified: 0 });
        expect(json.probes.command.probed).toBeGreaterThanOrEqual(4);
        expect(res.status).toBe(0);
        expect(json.exitCode).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  test('a direct engine call (no resolver): no per-command finding, one info, never an error', async () => {
    const root = fixture();
    try {
      const inspection = await inspectSharkcraft({ cwd: root });
      const report = await buildSelfConfigDoctorReportV2(inspection);
      expect(report.findings.filter((f) => f.code === 'unknown-command')).toEqual([]);
      const unverified = report.findings.filter((f) => f.code === 'command-probe-unverified');
      expect(unverified).toHaveLength(1);
      expect(unverified[0]!.severity).toBe(SelfConfigSeverityV2.Info);
      expect(report.probes.command.unverified).toBe(report.probes.command.probed);
      expect(report.verdict).not.toBe('errors');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(
    '`shrk test agent` passes a correct `expectedCommands` entry (it failed against the empty set)',
    () => {
      const root = fixture();
      try {
        const res = shrk(root, ['test', 'agent', '--json']);
        const json = JSON.parse(res.stdout) as {
          exitCode: number;
          results: { id: string; passed: boolean; verdict: string; missingCommands: string[] }[];
        };
        const at = json.results.find((r) => r.id === 'at.cmd');
        expect(at?.missingCommands).toEqual([]);
        expect(at?.passed).toBe(true);
        expect(at?.verdict).toBe('pass');
        expect(res.status).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});
