import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSafetyAudit, inspectSharkcraft } from '../index.ts';

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'safety-audit-'));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'sa', version: '0.0.0' }),
  );
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    [
      `export default {`,
      `  projectName: 'sa',`,
      `  knowledgeFiles: [],`,
      `  ruleFiles: [],`,
      `  pathFiles: [],`,
      `  templateFiles: [],`,
      `  docsFiles: [],`,
      `  verificationCommands: [`,
      `    { id: 'smoke', label: 'smoke', command: 'echo ok', trusted: true },`,
      `    { id: 'risky', label: 'risky', command: 'rm -rf /', trusted: false },`,
      `  ],`,
      `};`,
    ].join('\n'),
  );
  return root;
}

const catalog = [
  {
    command: 'doctor',
    description: 'd',
    category: 'core',
    safetyLevel: 'read-only',
    writesFiles: false,
    writesSource: false,
    runsShell: false,
    requiresReview: false,
    mcpAvailable: true,
  },
  {
    command: 'apply',
    description: 'a',
    category: 'core',
    safetyLevel: 'writes-source',
    writesFiles: true,
    writesSource: true,
    runsShell: false,
    requiresReview: true,
    mcpAvailable: false,
  },
  {
    command: 'dev validate',
    description: 'v',
    category: 'dev',
    safetyLevel: 'runs-shell',
    writesFiles: true,
    writesSource: false,
    runsShell: true,
    requiresReview: false,
    mcpAvailable: false,
  },
];

const mcpTools = [
  { name: 'doctor_packs', description: 'doctor packs' },
  { name: 'get_safety_audit', description: 'audit' },
];

describe('buildSafetyAudit', () => {
  test('partitions commands by safety level', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const r = buildSafetyAudit({
      inspection,
      catalog,
      mcpTools,
      planSecretConfigured: false,
    });
    expect(r.commands.readOnly.some((c) => c.command === 'doctor')).toBe(true);
    expect(r.commands.writesSource.some((c) => c.command === 'apply')).toBe(true);
    expect(r.commands.runsShell.some((c) => c.command === 'dev validate')).toBe(true);
    expect(r.commands.requiresReview.some((c) => c.command === 'apply')).toBe(true);
  });

  test('MCP tools all report canWrite=false (read-only invariant)', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const r = buildSafetyAudit({
      inspection,
      catalog,
      mcpTools,
      planSecretConfigured: false,
    });
    expect(r.mcp.anyWritable).toBe(false);
    for (const t of r.mcp.tools) expect(t.canWrite).toBe(false);
  });

  test('untrusted verification commands are surfaced', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const r = buildSafetyAudit({
      inspection,
      catalog,
      mcpTools,
      planSecretConfigured: false,
    });
    expect(r.verifications.trusted.some((v) => v.id === 'smoke')).toBe(true);
    expect(r.verifications.untrusted.some((v) => v.id === 'risky')).toBe(true);
    expect(r.recommendations.some((s) => s.toLowerCase().includes('verification'))).toBe(true);
  });

  test('missing plan secret produces a recommendation', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const r = buildSafetyAudit({
      inspection,
      catalog,
      mcpTools,
      planSecretConfigured: false,
    });
    expect(r.planSigning.secretConfigured).toBe(false);
    expect(r.recommendations.some((s) => s.includes('SHARKCRAFT_PLAN_SECRET'))).toBe(true);
  });
});
