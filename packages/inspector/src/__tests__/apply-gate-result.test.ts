import { describe, expect, it } from 'bun:test';
import {
  APPLY_GATE_RESULT_SCHEMA,
  ApplyExitCategory,
  buildApplyGateResult,
} from '../apply-gate-result.ts';

describe('apply gate result', () => {
  it('ok category sets ok=true', () => {
    const r = buildApplyGateResult({ exitCategory: ApplyExitCategory.Ok });
    expect(r.ok).toBe(true);
    expect(r.schema).toBe(APPLY_GATE_RESULT_SCHEMA);
  });

  it('blocked-contract-gate carries failures + suggested command', () => {
    const r = buildApplyGateResult({
      exitCategory: ApplyExitCategory.BlockedContractGate,
      contractGateFailures: [{ id: 'risk-approval', status: 'requires-approval' }],
      suggestedNextCommand: 'shrk contract approve ...',
    });
    expect(r.ok).toBe(false);
    expect(r.exitCategory).toBe(ApplyExitCategory.BlockedContractGate);
    expect(r.contractGateFailures).toHaveLength(1);
  });

  it('signature/conflict/divergence exit categories pass through', () => {
    const sig = buildApplyGateResult({ exitCategory: ApplyExitCategory.BlockedSignature });
    expect(sig.exitCategory).toBe(ApplyExitCategory.BlockedSignature);
    const c = buildApplyGateResult({ exitCategory: ApplyExitCategory.BlockedConflict });
    expect(c.exitCategory).toBe(ApplyExitCategory.BlockedConflict);
    const d = buildApplyGateResult({ exitCategory: ApplyExitCategory.BlockedDivergence });
    expect(d.exitCategory).toBe(ApplyExitCategory.BlockedDivergence);
  });
});
