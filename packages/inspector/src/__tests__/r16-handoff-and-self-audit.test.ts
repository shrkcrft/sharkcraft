import { describe, expect, test } from 'bun:test';
import {
  buildAgentHandoff,
  buildSelfAudit,
  detectSharkcraftRepo,
  inspectSharkcraft,
} from '../index.ts';

describe('r16 agent handoff', () => {
  test('builds a task-only handoff with the expected sections', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const handoff = await buildAgentHandoff(inspection, { task: 'verify handoff packet' });
    expect(handoff.task).toBe('verify handoff packet');
    expect(handoff.nextSafeCommand).toBeTruthy();
    expect(handoff.markdown).toContain('Safety note');
    expect(handoff.markdown).toContain('Do NOT touch');
  });
  test('chunked handoff returns multiple chunks', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const handoff = await buildAgentHandoff(inspection, { task: 'continue work', chunked: true });
    expect(handoff.chunks).toBeDefined();
    expect(handoff.chunks!.length).toBeGreaterThanOrEqual(8);
    const ids = handoff.chunks!.map((c) => c.sectionId);
    expect(ids).toContain('next-command');
    expect(ids).toContain('safety');
  });
});

describe('r16 self audit', () => {
  test('detects the SharkCraft repo and aggregates verdicts', () => {
    const isRepo = detectSharkcraftRepo(process.cwd());
    expect(isRepo).toBe(true);
    const audit = buildSelfAudit(process.cwd(), {
      releaseReadinessReady: true,
      releaseReadinessBlockers: 0,
      releaseReadinessWarnings: 0,
      mcpAuditWriteToolCount: 0,
      docsCheckOk: true,
      examplesCheckOk: true,
    });
    expect(audit.isSharkcraftRepo).toBe(true);
    expect(audit.findings.some((f) => f.id === 'release-readiness' && f.status === 'pass')).toBe(true);
    expect(audit.ok).toBe(true);
  });
  test('non-SharkCraft repo emits the not-applicable finding only', () => {
    const audit = buildSelfAudit('/tmp', {});
    expect(audit.isSharkcraftRepo).toBe(false);
    expect(audit.findings[0]!.id).toBe('not-sharkcraft-repo');
  });
});
