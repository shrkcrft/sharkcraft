import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import {
  buildAgentContract,
  buildApproval,
  checkAgentContract,
  ContractGateStatus,
  computeContractHash,
  inspectSharkcraft,
} from '../index.ts';

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-r24-gate-'));
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

describe('contract gates', () => {
  it('low-risk contract passes with no plan and no approval', async () => {
    await withRoot(async (root) => {
      const inspection = await inspectSharkcraft({ cwd: root });
      const contract = await buildAgentContract('update documentation typos', inspection, {
        role: 'developer',
      });
      const r = await checkAgentContract(inspection, contract);
      expect(r.pass).toBe(true);
      expect(r.approvalStatus).toBe('absent');
      expect(r.gates.every((g) => g.status === ContractGateStatus.Pass || g.status === ContractGateStatus.Warn)).toBe(true);
    });
  });

  it('high-risk task contract requires approval and approval satisfies it', async () => {
    await withRoot(async (root) => {
      const inspection = await inspectSharkcraft({ cwd: root });
      const contract = await buildAgentContract(
        'change plugin-api public API for adapter rules (architecture)',
        inspection,
        { role: 'reviewer', files: ['plugin-api/src/index.ts'] },
      );
      const before = await checkAgentContract(inspection, contract);
      expect(before.pass).toBe(false);
      // Build an approval for the matching contract hash and write it to disk.
      const approvalPath = nodePath.join(root, 'approval.json');
      const approval = buildApproval({
        contractHash: computeContractHash(contract),
        approvedBy: 'bob',
        reason: 'reviewed',
      });
      writeFileSync(approvalPath, JSON.stringify(approval), 'utf8');
      const after = await checkAgentContract(inspection, contract, { approvalPath });
      expect(after.pass).toBe(true);
      // Approval bound to the exact contract hash.
      expect(after.approvalStatus === 'unsigned' || after.approvalStatus === 'verified').toBe(true);
    });
  });

  it('mismatched approval is rejected', async () => {
    await withRoot(async (root) => {
      const inspection = await inspectSharkcraft({ cwd: root });
      const contract = await buildAgentContract(
        'release v1.0.0 with publish and tag',
        inspection,
        { role: 'release-manager' },
      );
      const approvalPath = nodePath.join(root, 'approval.json');
      const wrongHash = '0'.repeat(64);
      const approval = buildApproval({
        contractHash: wrongHash,
        approvedBy: 'bob',
        reason: 'wrong contract',
      });
      writeFileSync(approvalPath, JSON.stringify(approval), 'utf8');
      const r = await checkAgentContract(inspection, contract, { approvalPath });
      expect(r.approvalStatus).toBe('mismatched');
      expect(r.pass).toBe(false);
    });
  });
});
