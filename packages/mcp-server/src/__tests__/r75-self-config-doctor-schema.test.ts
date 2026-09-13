/**
 * r75 — MCP `get_self_config_doctor` serves THE doctor (spec 1.6#2).
 *
 * The tool ran a second (v1) doctor with its own checks, so MCP and `shrk
 * self-config doctor` disagreed. v1 is now a projection of v2 and `schema`
 * only picks the SHAPE. The input is validated in TWO places — the advertised
 * inputSchema and the strict zod validator — so both are exercised here
 * (handler tests bypass the validator).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft, type ISharkcraftInspection } from '@shrkcrft/inspector';
import { getSelfConfigDoctorTool } from '../tools/r33-self-config.tool.ts';
import { validateToolInput } from '../server/tool-input-validators.ts';

const TIMEOUT_MS = 60_000;
let root = '';
let inspection: ISharkcraftInspection;

interface IReport {
  schema: string;
  verdict: string;
  findings: { code: string; targetId?: string; referencedId?: string }[];
  coverage: { unit: string; expected: number; examined: number }[];
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'shrk-r75-mcp-selfcfg-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'fx', knowledgeFiles: ['knowledge.ts'] };\n`,
    'sharkcraft/knowledge.ts': `export default [{ id: 'alpha.entry', title: 'Alpha', type: 'architecture', priority: 'high', tags: [], content: 'Alpha widgets.' }];\n`,
    'sharkcraft/search-tuning.ts': `export default [{ id: 't.bare', boostIds: { 'alpha.entry': 2 } }];\n`,
  };
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  inspection = await inspectSharkcraft({ cwd: root });
}, TIMEOUT_MS);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('r75 get_self_config_doctor', () => {
  test('schema "v2" returns the v2 shape; the default returns v1 — the same checks', async () => {
    const v2 = (await getSelfConfigDoctorTool.handler({ schema: 'v2' }, { inspection, cwd: root } as never)).data as IReport;
    const v1 = (await getSelfConfigDoctorTool.handler({}, { inspection, cwd: root } as never)).data as IReport;
    expect(v2.schema).toBe('sharkcraft.self-config-doctor/v2');
    expect(v1.schema).toBe('sharkcraft.self-config-doctor/v1');
    const pairs = (r: IReport): string[] =>
      r.findings
        .map((f) => `${f.code === 'pack-signature-stale' ? 'pack-conflict:stale-signature' : f.code}|${f.targetId ?? f.referencedId}`)
        .sort();
    expect(pairs(v1)).toEqual(pairs(v2));
    // v1 now carries the v2 checks it lacked: the bare boost key is flagged.
    expect(v1.findings.map((f) => f.code)).toContain('search-tuning-key-unprefixed');
    expect(v1.verdict).toBe(v2.verdict);
  });

  test('command strings are reported NOT verified over MCP — coverage, never a pass', async () => {
    const v2 = (await getSelfConfigDoctorTool.handler({ schema: 'v2' }, { inspection, cwd: root } as never)).data as IReport;
    const cmd = v2.coverage.find((c) => c.unit === 'command strings');
    expect(cmd).toBeDefined();
    expect(cmd!.examined).toBe(0);
    expect(v2.findings.filter((f) => f.code === 'command-probe-unverified')).toHaveLength(1);
    expect(v2.verdict).toBe('unverified');
  });

  test('the wire validator accepts exactly what the inputSchema advertises', () => {
    expect(getSelfConfigDoctorTool.inputSchema.properties).toHaveProperty('schema');
    expect(validateToolInput('get_self_config_doctor', {}).ok).toBe(true);
    expect(validateToolInput('get_self_config_doctor', { schema: 'v1' }).ok).toBe(true);
    expect(validateToolInput('get_self_config_doctor', { schema: 'v2' }).ok).toBe(true);
    expect(validateToolInput('get_self_config_doctor', { schema: 'v3' }).ok).toBe(false);
    expect(validateToolInput('get_self_config_doctor', { other: true }).ok).toBe(false);
  });
});
