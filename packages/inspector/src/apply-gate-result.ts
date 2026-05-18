/**
 * Structured apply gate result.
 *
 * `shrk apply --contract` returns nonzero when blocked but the JSON
 * output does not distinguish *why* (gate failure vs. signature vs. conflict
 * vs. divergence). CI can branch on the human-readable text but not on a
 * stable field. This module defines `IApplyGateResult` so JSON consumers can
 * branch deterministically.
 */

export const APPLY_GATE_RESULT_SCHEMA = 'sharkcraft.apply-gate/v1';

export enum ApplyExitCategory {
  Ok = 'ok',
  BlockedContractGate = 'blocked-contract-gate',
  BlockedSignature = 'blocked-signature',
  BlockedConflict = 'blocked-conflict',
  BlockedDivergence = 'blocked-divergence',
  BlockedPolicy = 'blocked-policy',
  BlockedBoundary = 'blocked-boundary',
  BlockedValidation = 'blocked-validation',
  /** Folder operation requires explicit allow flag(s). */
  BlockedFolderOpAllowFlag = 'blocked-folder-op-allow-flag',
  /** Folder operation path is unsafe (refused before any FS touch). */
  BlockedFolderOpUnsafe = 'blocked-folder-op-unsafe',
  InvalidInput = 'invalid-input',
}

export interface IApplyContractGateFailure {
  id: string;
  status: string;
  detail?: string;
}

export interface IApplySignatureStatus {
  status: string;
  message?: string;
}

export interface IApplyGateResult {
  schema: typeof APPLY_GATE_RESULT_SCHEMA;
  generatedAt: string;
  ok: boolean;
  exitCategory: ApplyExitCategory;
  contractGateFailures?: readonly IApplyContractGateFailure[];
  signatureStatus?: IApplySignatureStatus;
  suggestedNextCommand?: string;
  notes?: readonly string[];
}

export function buildApplyGateResult(input: {
  exitCategory: ApplyExitCategory;
  contractGateFailures?: readonly IApplyContractGateFailure[];
  signatureStatus?: IApplySignatureStatus;
  suggestedNextCommand?: string;
  notes?: readonly string[];
}): IApplyGateResult {
  const out: IApplyGateResult = {
    schema: APPLY_GATE_RESULT_SCHEMA,
    generatedAt: new Date().toISOString(),
    ok: input.exitCategory === ApplyExitCategory.Ok,
    exitCategory: input.exitCategory,
  };
  if (input.contractGateFailures && input.contractGateFailures.length > 0) {
    out.contractGateFailures = input.contractGateFailures;
  }
  if (input.signatureStatus) out.signatureStatus = input.signatureStatus;
  if (input.suggestedNextCommand) out.suggestedNextCommand = input.suggestedNextCommand;
  if (input.notes && input.notes.length > 0) out.notes = input.notes;
  return out;
}
