/**
 * r77 — the MCP asset doctors agree with the CLI (round 13, lane A; DECISIONS §6).
 *
 *   - `get_scaffold_pattern_doctor` counted errors from the definitions only:
 *     a pattern its loader REFUSED (no `confidence`) was invisible, and it
 *     returned no verdict — "errors: 0" where `shrk scaffolds doctor` exited 1.
 *     It now reads THE scaffold-pattern doctor report and settles through THE
 *     asset-doctor proposal: `rejected`, `verdict`, `exitCode`, `accepted`.
 *   - `get_self_config_doctor` carries the settled fields (`accepted`,
 *     `exitCode`, `settledVerdict`, `shortfalls`) in both schemas.
 *
 * Handler calls, plus the dispatch validator (the dual-schema gotcha: handler
 * tests bypass it).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { validateToolInput } from '../server/tool-input-validators.ts';
import { getSelfConfigDoctorTool } from '../tools/r33-self-config.tool.ts';
import { getScaffoldPatternDoctorTool } from '../tools/scaffold-patterns.tool.ts';

const TIMEOUT_MS = 60_000;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function workspace(patterns: string): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r77-mcp-assets-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
    'sharkcraft/scaffold-patterns.ts': `export default [${patterns}];\n`,
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const PLANNED =
  "{ id: 'fm.ok', title: 'OK', description: 'd', templateId: 'fx.none', matchPaths: [{ pattern: 'src/plugins/*/plugin.ts', expectEmpty: true }], variables: [], appliesWhen: ['infer-template'], confidence: 'high' }";
const NO_CONFIDENCE = "{ id: 'fm.bad', title: 'Bad', templateId: 'fx.none', matchPaths: ['src/**/*.ts'] }";

interface IScaffoldDoctorData {
  readonly errors: number;
  readonly rejected: readonly { readonly entryId?: string; readonly reasons: readonly string[] }[];
  readonly exitCode: number;
  readonly verdict: string;
  readonly accepted: readonly string[];
  readonly dead: number;
}

describe('r77 MCP get_scaffold_pattern_doctor ≡ shrk scaffolds doctor', () => {
  test('its input is validated at the wire (no inputs)', () => {
    expect(validateToolInput('get_scaffold_pattern_doctor', {}).ok).toBe(true);
  });

  test(
    'a pattern the loader refused is an error it names, with the settled verdict (1)',
    async () => {
      const root = workspace(`${PLANNED}, ${NO_CONFIDENCE}`);
      const inspection = await inspectSharkcraft({ cwd: root });
      const data = (await getScaffoldPatternDoctorTool.handler({}, { inspection, cwd: root } as never)).data as IScaffoldDoctorData;
      expect(data.rejected.map((r) => r.entryId)).toEqual(['fm.bad']);
      expect(data.errors).toBe(1);
      expect({ exitCode: data.exitCode, verdict: data.verdict, accepted: data.accepted }).toEqual({
        exitCode: 1,
        verdict: 'fail',
        accepted: [],
      });
    },
    TIMEOUT_MS,
  );

  test(
    'a planned glob is ONE acceptance at exit 0 — the same `accepted` line the CLI prints',
    async () => {
      const root = workspace(PLANNED);
      const inspection = await inspectSharkcraft({ cwd: root });
      const data = (await getScaffoldPatternDoctorTool.handler({}, { inspection, cwd: root } as never)).data as IScaffoldDoctorData;
      expect({ exitCode: data.exitCode, verdict: data.verdict, dead: data.dead }).toEqual({ exitCode: 0, verdict: 'pass', dead: 0 });
      expect(data.accepted).toHaveLength(1);
      expect(data.accepted[0]).toContain('accepted by expectEmpty');
    },
    TIMEOUT_MS,
  );
});

describe('r77 MCP get_self_config_doctor carries the settled verdict', () => {
  test(
    'both schemas carry accepted / exitCode / settledVerdict / shortfalls; the acceptance record rides in coverage',
    async () => {
      const root = workspace(PLANNED);
      const inspection = await inspectSharkcraft({ cwd: root });
      for (const input of [{}, { schema: 'v2' }]) {
        expect(validateToolInput('get_self_config_doctor', input).ok).toBe(true);
        const data = (await getSelfConfigDoctorTool.handler(input, { inspection, cwd: root } as never)).data as {
          exitCode: number;
          settledVerdict: string;
          shortfalls: string[];
          accepted: string[];
          coverage: { acceptedBy?: string; subject?: string }[];
        };
        expect(Array.isArray(data.accepted)).toBe(true);
        expect(typeof data.exitCode).toBe('number');
        expect(data.settledVerdict).toBe(data.exitCode === 0 ? 'pass' : data.exitCode === 2 ? 'not-verified' : 'fail');
        expect(data.coverage.some((c) => c.acceptedBy === 'expectEmpty' && c.subject === 'scaffold patterns')).toBe(true);
        // MCP has no command index, so prescribed command strings stay NOT verified
        // (2) — and an acceptance is only ever printed next to a clean 0.
        if (data.exitCode !== 0) expect(data.accepted).toEqual([]);
      }
    },
    TIMEOUT_MS,
  );
});
