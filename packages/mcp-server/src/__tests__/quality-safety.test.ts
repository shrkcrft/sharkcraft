import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALL_TOOLS } from '../tools/index.ts';
// DX#4 — `ALL_TOOLS_FOR_AUDIT` deleted (parallel static list). The
// audit view is `ALL_TOOLS.map(t => ({ name, description }))` —
// structurally identical to ALL_TOOLS by construction.
import { inspectSharkcraft } from '@shrkcrft/inspector';

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'mcp-q-'));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'q', version: '0.0.0' }),
  );
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default { projectName: 'q', knowledgeFiles: [], ruleFiles: [], pathFiles: [], templateFiles: [], docsFiles: [] };\n`,
  );
  return root;
}

describe('MCP get_quality_report', () => {
  test('returns the structured report and never writes files', async () => {
    const root = makeFixture();
    const before = readdirSync(root).sort();
    const inspection = await inspectSharkcraft({ cwd: root });
    const tool = ALL_TOOLS.find((t) => t.name === 'get_quality_report');
    expect(tool).toBeDefined();
    const r = await tool!.handler({}, { inspection, cwd: root });
    expect(r.isError ?? false).toBe(false);
    const data = r.data as {
      overall: string;
      gates: { id: string }[];
      nextCommand: string;
      note: string;
    };
    expect(data.gates.some((g) => g.id === 'drift')).toBe(true);
    expect(data.nextCommand).toContain('shrk quality');
    expect(data.note.toLowerCase()).toContain('mcp cannot execute');
    const after = readdirSync(root).sort();
    expect(after).toEqual(before);
  });

  test('honours requireDriftClean', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const tool = ALL_TOOLS.find((t) => t.name === 'get_quality_report')!;
    const r = await tool.handler({ requireDriftClean: true }, { inspection, cwd: root });
    const data = r.data as { gates: { id: string; blocking: boolean }[] };
    const drift = data.gates.find((g) => g.id === 'drift')!;
    expect(drift.blocking).toBe(true);
  });
});

describe('MCP get_safety_audit', () => {
  test('returns a safety report with anyWritable=false', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const tool = ALL_TOOLS.find((t) => t.name === 'get_safety_audit');
    expect(tool).toBeDefined();
    const r = await tool!.handler({}, { inspection, cwd: root });
    expect(r.isError ?? false).toBe(false);
    const data = r.data as {
      mcp: { anyWritable: boolean; tools: { canWrite: boolean }[] };
      commands: { writesSource: unknown[] };
    };
    expect(data.mcp.anyWritable).toBe(false);
    for (const t of data.mcp.tools) expect(t.canWrite).toBe(false);
  });
});

describe('ALL_TOOLS audit projection', () => {
  test('audit projection is structurally the same as the runtime list', () => {
    // DX#4 — the audit view is now derived from ALL_TOOLS at runtime.
    // Parity is by construction; this test just exercises the projection.
    const audit = ALL_TOOLS.map((t) => ({ name: t.name, description: t.description }));
    expect(audit.length).toBe(ALL_TOOLS.length);
    for (const a of audit) {
      expect(typeof a.name).toBe('string');
      expect(typeof a.description).toBe('string');
    }
  });
});
