import { describe, expect, test } from 'bun:test';
import {
  getComplianceProfile,
  inspectSharkcraft,
  listComplianceProfiles,
  runComplianceCheck,
} from '../index.ts';

describe('r18 compliance profiles', () => {
  test('lists 4+ built-in profiles', () => {
    const profiles = listComplianceProfiles();
    expect(profiles.length).toBeGreaterThanOrEqual(4);
    expect(profiles.find((p) => p.id === 'ai-safe-development')).toBeDefined();
    expect(profiles.find((p) => p.id === 'signed-pack-workflow')).toBeDefined();
  });
  test('ai-safe-development profile requires MCP read-only', () => {
    const p = getComplianceProfile('ai-safe-development');
    expect(p?.requiredMcpReadOnly).toBe(true);
  });
  test('unknown profile id is surfaced as an error finding', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const r = await runComplianceCheck(inspection, 'nope');
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.ruleId === 'unknown-profile')).toBe(true);
  });
  test('ai-safe-development check surfaces an MCP-no-write info hint', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const r = await runComplianceCheck(inspection, 'ai-safe-development');
    expect(r.findings.some((f) => f.ruleId === 'mcp-no-write-hint')).toBe(true);
  });
});
