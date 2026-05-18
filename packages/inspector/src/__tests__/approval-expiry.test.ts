import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import {
  buildAgentContract,
  buildApproval,
  checkAgentContract,
  computeContractHash,
  ContractApprovalExpiryStatus,
  inspectSharkcraft,
  parseRelativeExpiry,
  TaskRiskLevel,
} from '../index.ts';

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-r25-expiry-'));
  try {
    writeFileSync(
      nodePath.join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '0.0.0' }),
    );
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('contract approval expiry', () => {
  it('parseRelativeExpiry handles m/h/d/w', () => {
    const now = new Date(Date.UTC(2026, 4, 14, 0, 0, 0));
    expect(parseRelativeExpiry('30m', now)).toBe(new Date(now.getTime() + 30 * 60 * 1000).toISOString());
    expect(parseRelativeExpiry('2h', now)).toBe(new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString());
    expect(parseRelativeExpiry('7d', now)).toBe(new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString());
    expect(parseRelativeExpiry('1w', now)).toBe(new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString());
    expect(parseRelativeExpiry('bogus', now)).toBeNull();
  });

  it('valid approval reports status=valid + remaining time', async () => {
    await withRoot(async (root) => {
      const inspection = await inspectSharkcraft({ cwd: root });
      const contract = await buildAgentContract('safe task', inspection);
      const approval = buildApproval({
        contractHash: computeContractHash(contract),
        approvedBy: 'tester',
        reason: 'unit test',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });
      const approvalPath = nodePath.join(root, 'approval.json');
      writeFileSync(approvalPath, JSON.stringify(approval));
      const report = await checkAgentContract(inspection, contract, { approvalPath });
      expect(report.approvalExpiry?.status).toBe(ContractApprovalExpiryStatus.Valid);
      expect(report.approvalExpiry?.expiresInMs).toBeGreaterThan(0);
    });
  });

  it('expired approval reports status=expired', async () => {
    await withRoot(async (root) => {
      const inspection = await inspectSharkcraft({ cwd: root });
      const contract = await buildAgentContract('safe task', inspection);
      const approval = buildApproval({
        contractHash: computeContractHash(contract),
        approvedBy: 'tester',
        reason: 'unit test',
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      const approvalPath = nodePath.join(root, 'approval.json');
      writeFileSync(approvalPath, JSON.stringify(approval));
      const report = await checkAgentContract(inspection, contract, { approvalPath });
      expect(report.approvalExpiry?.status).toBe(ContractApprovalExpiryStatus.Expired);
      expect(report.approvalStatus).toBe('expired');
    });
  });

  it('expiresSoon when remaining < 4h', async () => {
    await withRoot(async (root) => {
      const inspection = await inspectSharkcraft({ cwd: root });
      const contract = await buildAgentContract('safe task', inspection);
      const approval = buildApproval({
        contractHash: computeContractHash(contract),
        approvedBy: 'tester',
        reason: 'unit test',
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      const approvalPath = nodePath.join(root, 'approval.json');
      writeFileSync(approvalPath, JSON.stringify(approval));
      const report = await checkAgentContract(inspection, contract, { approvalPath });
      expect(report.approvalExpiry?.status).toBe(ContractApprovalExpiryStatus.ExpiresSoon);
    });
  });

  it('high-risk no-expiry surfaces a warning', async () => {
    await withRoot(async (root) => {
      const inspection = await inspectSharkcraft({ cwd: root });
      // Force high risk by tagging the task and contract risk directly.
      const baseline = await buildAgentContract('release publish new version', inspection, { role: 'release-manager' });
      const contract = { ...baseline, taskRisk: { ...baseline.taskRisk, riskLevel: TaskRiskLevel.High } };
      const approval = buildApproval({
        contractHash: computeContractHash(contract),
        approvedBy: 'tester',
        reason: 'unit test',
      });
      const approvalPath = nodePath.join(root, 'approval.json');
      writeFileSync(approvalPath, JSON.stringify(approval));
      const report = await checkAgentContract(inspection, contract, { approvalPath });
      expect(report.approvalExpiry?.status).toBe(ContractApprovalExpiryStatus.NoExpiry);
      expect(report.approvalExpiry?.noExpiryWarning).toBeDefined();
    });
  });
});
