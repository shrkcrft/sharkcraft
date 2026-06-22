/**
 * Package a delegate worker's raw edit into a SIGNED-ready synthetic plan.
 *
 * This is the deterministic chokepoint between a stochastic worker and the
 * write path. It:
 *   1. drops ops whose `kind` is not in the recipe's `allowedOps` (reported,
 *      never applied);
 *   2. validates every remaining op's fields against the real operation union —
 *      a malformed op refuses the whole package (the worker must retry);
 *   3. evaluates the ops against the live file system via the SAME
 *      `evaluateSavedPlanInPlace` apply uses, so anchor-not-found / ambiguous /
 *      file-missing all surface as conflicts BEFORE anything is signed;
 *   4. builds an `ISavedPlan` (templateId `__delegate/<recipe>`) the caller
 *      signs + applies through the unmodified apply pipeline.
 *
 * No model, no network. The raw-op input type is declared locally so the
 * generator layer carries no dependency on `@shrkcrft/ai`.
 */
import { err, ok, AppErrorImpl, ERROR_CODES, type AppError, type Result } from '@shrkcrft/core';
import type { IGenerationPlan } from './generation-plan.ts';
import type { ISavedPlan } from './saved-plan.ts';
import { buildSavedPlan } from './saved-plan.ts';
import { evaluateSavedPlanInPlace } from './synthetic-plan.ts';
import type {
  IAppendOperation,
  ICreateOperation,
  IEnsureImportOperation,
  IExportOperation,
  IInsertAfterOperation,
  IInsertArrayEntryOperation,
  IInsertBeforeClosingBraceOperation,
  IInsertBeforeOperation,
  IInsertBetweenAnchorsOperation,
  IInsertEnumEntryOperation,
  IInsertObjectEntryOperation,
  IPlannedOperation,
  IReplaceOperation,
} from './operations.ts';

export const DELEGATE_TEMPLATE_PREFIX = '__delegate/';

/** A raw operation as parsed from a worker (structurally `IDelegateRawOp`). */
export interface IDelegateOpInput {
  targetPath: string;
  operation: { kind: string } & Record<string, unknown>;
}

export interface IPackageDelegateInput {
  ops: readonly IDelegateOpInput[];
  /** `IPlannedOperation` kinds the recipe permits; others are dropped. */
  allowedOps: readonly string[];
  /** Recipe id — becomes the synthetic templateId `__delegate/<id>`. */
  recipeId: string;
  projectRoot: string;
}

export interface IDroppedOp {
  kind: string;
  targetPath: string;
  reason: string;
}

export interface IPackageDelegateResult {
  /** Conflict-free, ready to sign. Present only when `ready`. */
  plan?: ISavedPlan;
  /** The evaluated generation plan (changes + conflicts) — always present. */
  generation: IGenerationPlan;
  /** Ops whose kind was not in `allowedOps`. */
  droppedOps: readonly IDroppedOp[];
  /** True when no conflicts — the plan is built and ready to sign + apply. */
  ready: boolean;
}

export function packageDelegatePlan(
  input: IPackageDelegateInput,
): Result<IPackageDelegateResult, AppError> {
  const allowed = new Set(input.allowedOps);
  const droppedOps: IDroppedOp[] = [];
  const expectedChanges: {
    type: string;
    relativePath: string;
    sizeBytes: number;
    operation: IPlannedOperation;
  }[] = [];

  for (const raw of input.ops) {
    const kind = raw.operation.kind;
    if (!allowed.has(kind)) {
      droppedOps.push({
        kind,
        targetPath: raw.targetPath,
        reason: `op kind "${kind}" is not in the recipe's allowedOps`,
      });
      continue;
    }
    const coerced = coerceOperation(raw.operation);
    if (!coerced.ok) {
      return err(
        new AppErrorImpl(ERROR_CODES.INVALID_INPUT, `delegate op for ${raw.targetPath}: ${coerced.error}`),
      );
    }
    expectedChanges.push({
      type: 'pending',
      relativePath: raw.targetPath,
      sizeBytes: 0,
      operation: coerced.value,
    });
  }

  if (expectedChanges.length === 0) {
    return err(
      new AppErrorImpl(
        ERROR_CODES.INVALID_INPUT,
        droppedOps.length > 0
          ? `delegate edit had ${droppedOps.length} op(s), all of disallowed kinds`
          : 'delegate edit contained no operations',
      ),
    );
  }

  // Evaluate against the live FS through the SAME path apply uses — conflicts
  // (ambiguous anchor, file missing, replace 0/>N) surface here, before signing.
  const draft: ISavedPlan = {
    schema: 'sharkcraft.plan/v2',
    templateId: `${DELEGATE_TEMPLATE_PREFIX}${input.recipeId}`,
    variables: {},
    projectRoot: input.projectRoot,
    createdAt: new Date().toISOString(),
    expectedChanges,
  };
  const generation = evaluateSavedPlanInPlace(draft, input.projectRoot);

  if (generation.hasConflicts) {
    return ok({ generation, droppedOps, ready: false });
  }

  const plan = buildSavedPlan({
    templateId: draft.templateId,
    variables: {},
    projectRoot: input.projectRoot,
    plan: generation,
  });
  return ok({ plan, generation, droppedOps, ready: true });
}

// ─── per-kind validation/coercion (strict, type-safe) ────────────────────────

type CoerceResult = { ok: true; value: IPlannedOperation } | { ok: false; error: string };

function coerceOperation(raw: { kind: string } & Record<string, unknown>): CoerceResult {
  const k = raw.kind;
  switch (k) {
    case 'create': {
      const content = reqStr(raw, 'content');
      if (content === null) return fail('content');
      const op: ICreateOperation = { kind: 'create', content };
      addOptStr(op, raw, 'description');
      return { ok: true, value: op };
    }
    case 'append': {
      const snippet = reqStr(raw, 'snippet');
      if (snippet === null) return fail('snippet');
      const op: IAppendOperation = { kind: 'append', snippet };
      addOptStr(op, raw, 'ifMissing');
      addOptStr(op, raw, 'description');
      return { ok: true, value: op };
    }
    case 'insert-after':
    case 'insert-before': {
      const anchor = reqStr(raw, 'anchor');
      const snippet = reqStr(raw, 'snippet');
      if (anchor === null) return fail('anchor');
      if (snippet === null) return fail('snippet');
      const op: IInsertAfterOperation | IInsertBeforeOperation = { kind: k, anchor, snippet };
      addOptStr(op, raw, 'ifMissing');
      addOptStr(op, raw, 'description');
      return { ok: true, value: op };
    }
    case 'replace': {
      const find = reqStr(raw, 'find');
      const replaceWith = reqStrAllowEmpty(raw, 'replaceWith');
      if (find === null) return fail('find');
      if (replaceWith === null) return fail('replaceWith');
      const op: IReplaceOperation = { kind: 'replace', find, replaceWith };
      const expectMatches = optNum(raw, 'expectMatches');
      if (expectMatches !== undefined) op.expectMatches = expectMatches;
      addOptStr(op, raw, 'description');
      return { ok: true, value: op };
    }
    case 'export': {
      const from = reqStr(raw, 'from');
      if (from === null) return fail('from');
      const op: IExportOperation = { kind: 'export', from };
      const symbols = optStrArr(raw, 'symbols');
      if (symbols) op.symbols = symbols;
      addOptStr(op, raw, 'ifMissing');
      addOptStr(op, raw, 'description');
      return { ok: true, value: op };
    }
    case 'ensure-import': {
      const from = reqStr(raw, 'from');
      if (from === null) return fail('from');
      const op: IEnsureImportOperation = { kind: 'ensure-import', from };
      const symbols = optStrArr(raw, 'symbols');
      if (symbols) op.symbols = symbols;
      const typeOnly = optBool(raw, 'typeOnly');
      if (typeOnly !== undefined) op.typeOnly = typeOnly;
      addOptStr(op, raw, 'defaultBinding');
      addOptStr(op, raw, 'namespaceBinding');
      addOptStr(op, raw, 'description');
      return { ok: true, value: op };
    }
    case 'insert-enum-entry': {
      const enumName = reqStr(raw, 'enumName');
      const entryName = reqStr(raw, 'entryName');
      const entryValue = reqStr(raw, 'entryValue');
      if (enumName === null) return fail('enumName');
      if (entryName === null) return fail('entryName');
      if (entryValue === null) return fail('entryValue');
      const op: IInsertEnumEntryOperation = { kind: 'insert-enum-entry', enumName, entryName, entryValue };
      addOptStr(op, raw, 'description');
      return { ok: true, value: op };
    }
    case 'insert-object-entry': {
      const objectName = reqStr(raw, 'objectName');
      const entryKey = reqStr(raw, 'entryKey');
      const entryValue = reqStr(raw, 'entryValue');
      if (objectName === null) return fail('objectName');
      if (entryKey === null) return fail('entryKey');
      if (entryValue === null) return fail('entryValue');
      const op: IInsertObjectEntryOperation = { kind: 'insert-object-entry', objectName, entryKey, entryValue };
      const shorthand = optBool(raw, 'shorthand');
      if (shorthand !== undefined) op.shorthand = shorthand;
      addOptStr(op, raw, 'description');
      return { ok: true, value: op };
    }
    case 'insert-array-entry': {
      const arrayName = reqStr(raw, 'arrayName');
      const entryValue = reqStr(raw, 'entryValue');
      if (arrayName === null) return fail('arrayName');
      if (entryValue === null) return fail('entryValue');
      const op: IInsertArrayEntryOperation = { kind: 'insert-array-entry', arrayName, entryValue };
      addOptStr(op, raw, 'ifMissing');
      addOptStr(op, raw, 'description');
      return { ok: true, value: op };
    }
    case 'insert-before-closing-brace': {
      const containerName = reqStr(raw, 'containerName');
      const snippet = reqStr(raw, 'snippet');
      if (containerName === null) return fail('containerName');
      if (snippet === null) return fail('snippet');
      const op: IInsertBeforeClosingBraceOperation = { kind: 'insert-before-closing-brace', containerName, snippet };
      addOptStr(op, raw, 'ifMissing');
      addOptStr(op, raw, 'description');
      return { ok: true, value: op };
    }
    case 'insert-between-anchors': {
      const beginAnchor = reqStr(raw, 'beginAnchor');
      const endAnchor = reqStr(raw, 'endAnchor');
      const snippet = reqStr(raw, 'snippet');
      if (beginAnchor === null) return fail('beginAnchor');
      if (endAnchor === null) return fail('endAnchor');
      if (snippet === null) return fail('snippet');
      const op: IInsertBetweenAnchorsOperation = { kind: 'insert-between-anchors', beginAnchor, endAnchor, snippet };
      addOptStr(op, raw, 'ifMissing');
      addOptStr(op, raw, 'description');
      return { ok: true, value: op };
    }
    default:
      return { ok: false, error: `unsupported op kind "${k}"` };
  }
}

function fail(field: string): CoerceResult {
  return { ok: false, error: `"${field}" must be a non-empty string` };
}

function reqStr(raw: Record<string, unknown>, field: string): string | null {
  const v = raw[field];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function reqStrAllowEmpty(raw: Record<string, unknown>, field: string): string | null {
  const v = raw[field];
  return typeof v === 'string' ? v : null;
}
function addOptStr(target: { description?: string; ifMissing?: string; defaultBinding?: string; namespaceBinding?: string }, raw: Record<string, unknown>, field: 'description' | 'ifMissing' | 'defaultBinding' | 'namespaceBinding'): void {
  const v = raw[field];
  if (typeof v === 'string') target[field] = v;
}
function optStrArr(raw: Record<string, unknown>, field: string): readonly string[] | undefined {
  const v = raw[field];
  if (Array.isArray(v) && v.every((s) => typeof s === 'string')) return v as readonly string[];
  return undefined;
}
function optBool(raw: Record<string, unknown>, field: string): boolean | undefined {
  const v = raw[field];
  return typeof v === 'boolean' ? v : undefined;
}
function optNum(raw: Record<string, unknown>, field: string): number | undefined {
  const v = raw[field];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
