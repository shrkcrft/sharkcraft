import { describe, expect, test } from 'bun:test';
import {
  applyPolicyOverrides,
  POLICY_OVERRIDES_SCHEMA,
  PolicySeverity,
  type IPolicyCheck,
  type IPolicyReport,
} from '../index.ts';

function fakeReport(checks: IPolicyCheck[]): IPolicyReport {
  return {
    schema: 'sharkcraft.policy-report/v1' as IPolicyReport['schema'],
    generatedAt: '2026-05-14T00:00:00.000Z',
    projectRoot: '/tmp/test',
    checks,
    registrations: [],
    summary: { info: 0, warning: 0, error: 0, critical: 0, passed: false },
  };
}

describe('r18 policy overrides', () => {
  test('disable removes a check from the report', () => {
    const r = fakeReport([
      { id: 'p1', title: 'P1', severity: PolicySeverity.Error, checkType: 'plan' as never, message: 'fail' },
    ]);
    const { report, explain } = applyPolicyOverrides(r, [
      { policyId: 'p1', enabled: false, reason: 'tracking elsewhere' },
    ]);
    expect(report.checks.length).toBe(0);
    expect(report.summary.passed).toBe(true);
    expect(explain.applied[0]?.disabled).toBe(true);
    expect(explain.applied[0]?.reason).toBe('tracking elsewhere');
    expect(explain.schema).toBe(POLICY_OVERRIDES_SCHEMA);
  });
  test('severity override promotes warning to error', () => {
    const r = fakeReport([
      { id: 'p2', title: 'P2', severity: PolicySeverity.Warning, checkType: 'plan' as never, message: 'm' },
    ]);
    const { report, explain } = applyPolicyOverrides(r, [
      { policyId: 'p2', severity: PolicySeverity.Error, reason: 'team policy' },
    ]);
    expect(report.checks[0]!.severity).toBe(PolicySeverity.Error);
    expect(explain.applied[0]!.appliedSeverity).toBe(PolicySeverity.Error);
    expect(explain.applied[0]!.originalSeverity).toBe(PolicySeverity.Warning);
    expect(report.summary.passed).toBe(false);
  });
  test('non-matching override leaves checks untouched', () => {
    const r = fakeReport([
      { id: 'p3', title: 'P3', severity: PolicySeverity.Info, checkType: 'plan' as never, message: 'm' },
    ]);
    const { report, explain } = applyPolicyOverrides(r, [{ policyId: 'nope' }]);
    expect(report.checks.length).toBe(1);
    expect(explain.applied.length).toBe(0);
  });
});
