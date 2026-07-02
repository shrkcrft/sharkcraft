import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { AppErrorImpl, ERROR_CODES, err, ok, type AppError, type Result } from '@shrkcrft/core';
import type { IGenerationPlan } from './generation-plan.ts';
import type { IPlannedOperation } from './planned-change.ts';

/** v1 schema marker — kept for legacy CREATE-only plans. */
export const SAVED_PLAN_SCHEMA_V1 = 'sharkcraft.plan/v1';
/** v2 schema marker — emitted when any change carries a v2 operation. */
export const SAVED_PLAN_SCHEMA_V2 = 'sharkcraft.plan/v2';
/** Default exported alias — points at v1 for backward-compat with consumers. */
export const SAVED_PLAN_SCHEMA = SAVED_PLAN_SCHEMA_V1;

export type SavedPlanSchema = typeof SAVED_PLAN_SCHEMA_V1 | typeof SAVED_PLAN_SCHEMA_V2;

export interface ISavedPlanExpectedChange {
  type: string;
  relativePath: string;
  sizeBytes: number;
  /**
   * SHA-256 hex digest of the exact rendered body that `gen --print` shows.
   * Always emitted by `buildSavedPlan`; may be absent on legacy plans written
   * before body/digest persistence. The plan is the review/apply artifact, so
   * this digest lets a later review or apply verify — WITHOUT re-rendering —
   * that the live content still matches what was previewed. Covered by the
   * HMAC signature (canonical JSON includes the whole `expectedChanges`).
   */
  sha256?: string;
  /**
   * The exact rendered file body that would be written — byte-identical to
   * what `gen --print` / `--show-content` displays. Embedded so the saved
   * plan carries enough to be reviewed for correctness, diffed against HEAD,
   * and re-applied deterministically instead of storing only a byte count.
   * Always emitted by `buildSavedPlan`; may be absent on legacy plans. Covered
   * by the HMAC signature.
   */
  body?: string;
  /**
   * v2-only — the operation intent that produced this change. Present iff
   * the schema is `sharkcraft.plan/v2`. Tampering with this field invalidates
   * the HMAC signature (canonical JSON includes the whole `expectedChanges`).
   */
  operation?: IPlannedOperation;
}

/**
 * Folder operations carried by a saved plan.
 *
 * Folder ops are NOT files; they live alongside `expectedChanges`. The HMAC
 * signature naturally covers them because the canonical-JSON encoding sorts
 * keys and includes any present field. Apply executes folder ops via
 * `applyFolderOps()` after explicit `--allow-folder-ops` (and
 * `--allow-delete-folder` for deletes).
 */
export interface ISavedPlanFolderOp {
  kind: 'rename-folder' | 'delete-folder';
  targetPath: string;
  newPath?: string;
  reason?: string;
}

export interface ISavedPlan {
  /** Schema marker for forward-compat. */
  schema: SavedPlanSchema;
  templateId: string;
  /** Primary kebab-case name passed to the template. Optional. */
  name?: string;
  variables: Record<string, string>;
  /** Absolute path of the project root the plan was created against. */
  projectRoot: string;
  /** ISO timestamp of when the plan was saved. */
  createdAt: string;
  /**
   * Optional summary of the plan's expected changes at save time. Used as a
   * sanity check during `shrk apply`; if the live plan diverges, the CLI
   * surfaces a warning before writing.
   */
  expectedChanges?: ReadonlyArray<ISavedPlanExpectedChange>;
  /**
   * Folder operations carried alongside file changes. The HMAC
   * signature covers this field via canonical-JSON. Apply executes these
   * via `applyFolderOps()` only when explicit `--allow-folder-ops` (and
   * `--allow-delete-folder` for deletes) is passed.
   */
  folderOps?: ReadonlyArray<ISavedPlanFolderOp>;
  /** Optional free-form notes from whoever saved the plan. */
  note?: string;
  /**
   * Optional HMAC signature. Excluded from the canonical JSON that's signed.
   */
  signature?: {
    algo: 'sha256';
    hmac: string;
    signedAt: string;
  };
}

export interface BuildSavedPlanInput {
  templateId: string;
  name?: string;
  variables: Record<string, string>;
  projectRoot: string;
  plan: IGenerationPlan;
  note?: string;
  /**
   * Folder operations to carry alongside the file plan. Tags the plan
   * as v2.
   */
  folderOps?: readonly ISavedPlanFolderOp[];
}

/**
 * Build a saved plan. If any change in the plan carries a v2 operation, the
 * resulting plan is tagged `sharkcraft.plan/v2`; otherwise v1.
 */
export function buildSavedPlan(input: BuildSavedPlanInput): ISavedPlan {
  const hasV2Op = input.plan.changes.some((c) => c.operation !== undefined);
  const hasFolderOps = (input.folderOps?.length ?? 0) > 0;
  const expectedChanges = input.plan.changes.map((c) => {
    const entry: ISavedPlanExpectedChange = {
      type: String(c.type),
      relativePath: c.relativePath,
      sizeBytes: c.sizeBytes,
      // Persist the exact rendered body (what `--print` shows) plus its
      // digest, so the saved plan IS the reviewable / re-appliable artifact
      // rather than a bare byte count. Both are covered by the HMAC signature.
      sha256: sha256Hex(c.contents),
      body: c.contents,
    };
    if (c.operation !== undefined) entry.operation = c.operation;
    return entry;
  });
  const out: ISavedPlan = {
    schema: hasV2Op || hasFolderOps ? SAVED_PLAN_SCHEMA_V2 : SAVED_PLAN_SCHEMA_V1,
    templateId: input.templateId,
    variables: { ...input.variables },
    projectRoot: input.projectRoot,
    createdAt: new Date().toISOString(),
    expectedChanges,
  };
  if (input.name !== undefined) out.name = input.name;
  if (input.note !== undefined) out.note = input.note;
  if (hasFolderOps) out.folderOps = [...input.folderOps!];
  return out;
}

/** SHA-256 hex digest of a rendered file body (UTF-8). */
export function sha256Hex(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export function savePlanToFile(plan: ISavedPlan, filePath: string): Result<void, AppError> {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(plan, null, 2) + '\n', 'utf8');
    return ok(undefined);
  } catch (e) {
    return err(
      new AppErrorImpl(ERROR_CODES.FILE_WRITE_ERROR, `Failed to save plan: ${filePath}`, {
        details: { filePath },
        cause: e,
      }),
    );
  }
}

export function readPlanFromFile(filePath: string): Result<ISavedPlan, AppError> {
  if (!existsSync(filePath)) {
    return err(
      new AppErrorImpl(ERROR_CODES.NOT_FOUND, `Plan file not found: ${filePath}`, {
        details: { filePath },
      }),
    );
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (e) {
    return err(
      new AppErrorImpl(ERROR_CODES.FILE_READ_ERROR, `Failed to read plan: ${filePath}`, {
        details: { filePath },
        cause: e,
      }),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return err(
      new AppErrorImpl(ERROR_CODES.INVALID_INPUT, `Plan file is not valid JSON: ${filePath}`, {
        cause: e,
      }),
    );
  }
  const validation = validateSavedPlanShape(parsed);
  if (!validation.ok) return err(validation.error);
  return ok(validation.value);
}

function validateSavedPlanShape(value: unknown): Result<ISavedPlan, AppError> {
  if (!value || typeof value !== 'object') {
    return err(
      new AppErrorImpl(ERROR_CODES.INVALID_INPUT, 'Plan must be a JSON object'),
    );
  }
  const obj = value as Partial<ISavedPlan> & Record<string, unknown>;
  if (obj.schema !== SAVED_PLAN_SCHEMA_V1 && obj.schema !== SAVED_PLAN_SCHEMA_V2) {
    return err(
      new AppErrorImpl(
        ERROR_CODES.INVALID_INPUT,
        `Unsupported plan schema: ${String(obj.schema)} (expected ${SAVED_PLAN_SCHEMA_V1} or ${SAVED_PLAN_SCHEMA_V2})`,
      ),
    );
  }
  if (typeof obj.templateId !== 'string' || !obj.templateId) {
    return err(
      new AppErrorImpl(ERROR_CODES.INVALID_INPUT, 'Plan: templateId must be a non-empty string'),
    );
  }
  if (obj.variables === null || typeof obj.variables !== 'object') {
    return err(
      new AppErrorImpl(ERROR_CODES.INVALID_INPUT, 'Plan: variables must be an object'),
    );
  }
  for (const [k, v] of Object.entries(obj.variables as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      return err(
        new AppErrorImpl(
          ERROR_CODES.INVALID_INPUT,
          `Plan: variables.${k} must be a string (got ${typeof v})`,
        ),
      );
    }
  }
  if (typeof obj.projectRoot !== 'string' || !obj.projectRoot) {
    return err(
      new AppErrorImpl(ERROR_CODES.INVALID_INPUT, 'Plan: projectRoot must be a non-empty string'),
    );
  }
  if (typeof obj.createdAt !== 'string') {
    return err(
      new AppErrorImpl(ERROR_CODES.INVALID_INPUT, 'Plan: createdAt must be a string'),
    );
  }
  if (obj.name !== undefined && typeof obj.name !== 'string') {
    return err(new AppErrorImpl(ERROR_CODES.INVALID_INPUT, 'Plan: name must be a string'));
  }
  if (obj.folderOps !== undefined) {
    if (!Array.isArray(obj.folderOps)) {
      return err(
        new AppErrorImpl(ERROR_CODES.INVALID_INPUT, 'Plan: folderOps must be an array'),
      );
    }
    for (const f of obj.folderOps as readonly unknown[]) {
      if (!f || typeof f !== 'object') {
        return err(
          new AppErrorImpl(ERROR_CODES.INVALID_INPUT, 'Plan: folderOps entries must be objects'),
        );
      }
      const fo = f as Partial<ISavedPlanFolderOp>;
      if (fo.kind !== 'rename-folder' && fo.kind !== 'delete-folder') {
        return err(
          new AppErrorImpl(
            ERROR_CODES.INVALID_INPUT,
            `Plan: folderOps.kind must be "rename-folder" or "delete-folder" (got ${String(fo.kind)})`,
          ),
        );
      }
      if (typeof fo.targetPath !== 'string' || fo.targetPath.length === 0) {
        return err(
          new AppErrorImpl(
            ERROR_CODES.INVALID_INPUT,
            'Plan: folderOps.targetPath must be a non-empty string',
          ),
        );
      }
      if (fo.newPath !== undefined && typeof fo.newPath !== 'string') {
        return err(
          new AppErrorImpl(
            ERROR_CODES.INVALID_INPUT,
            'Plan: folderOps.newPath must be a string',
          ),
        );
      }
      if (fo.kind === 'rename-folder' && (fo.newPath === undefined || fo.newPath.length === 0)) {
        return err(
          new AppErrorImpl(
            ERROR_CODES.INVALID_INPUT,
            'Plan: folderOps[rename-folder] requires newPath',
          ),
        );
      }
    }
  }
  return ok(obj as ISavedPlan);
}

export interface IPlanDiff {
  relativePath: string;
  /**
   * "added" | "removed" | "type-changed" | "size-changed" |
   * "operation-changed" | "content-changed". `content-changed` fires when the
   * live body's digest differs from the saved `sha256` even though the byte
   * count matches — a same-size content edit that a size check alone would
   * miss.
   */
  kind:
    | 'added'
    | 'removed'
    | 'type-changed'
    | 'size-changed'
    | 'operation-changed'
    | 'content-changed';
  detail?: string;
}

/**
 * Compare the saved plan's expected changes with a freshly-computed plan's
 * changes. Returns an empty array when they match. v2 plans additionally
 * detect operation-intent drift (e.g. signed `append` became `replace` in
 * the template).
 */
export function diffPlanChanges(
  saved: ISavedPlan,
  fresh: IGenerationPlan,
): IPlanDiff[] {
  if (!saved.expectedChanges) return [];
  // Key by `path :: operation-fingerprint` so multiple ops on the
  // same file are tracked independently. Falls back to path-only keying
  // for v1 plans where `operation` is absent. Reordered independent ops
  // still match (the fingerprint is stable and does not depend on order).
  const out: IPlanDiff[] = [];
  const expectedByKey = new Map<string, ISavedPlanExpectedChange>();
  for (const e of saved.expectedChanges) {
    expectedByKey.set(`${e.relativePath}::${opFingerprint(e.operation, e.type)}`, e);
  }
  const freshByKey = new Map<string, IGenerationPlan['changes'][number]>();
  for (const c of fresh.changes) {
    freshByKey.set(`${c.relativePath}::${opFingerprint(c.operation, c.type)}`, c);
  }
  for (const [key, expected] of expectedByKey) {
    const actual = freshByKey.get(key);
    if (!actual) {
      // Try a same-path fallback to give a more useful "type-changed" /
      // "operation-changed" diagnostic when paths match but fingerprint
      // differs.
      const samePath = [...freshByKey.values()].find(
        (c) => c.relativePath === expected.relativePath,
      );
      if (samePath) {
        if (String(samePath.type) !== expected.type) {
          out.push({
            relativePath: expected.relativePath,
            kind: 'type-changed',
            detail: `${expected.type} → ${String(samePath.type)}`,
          });
        } else if (
          expected.operation !== undefined &&
          samePath.operation !== undefined &&
          !operationsEqual(expected.operation, samePath.operation)
        ) {
          out.push({
            relativePath: expected.relativePath,
            kind: 'operation-changed',
            detail: `${expected.operation.kind} intent drifted`,
          });
        } else {
          out.push({
            relativePath: expected.relativePath,
            kind: 'removed',
            detail: `expected op fingerprint not found on this path`,
          });
        }
        continue;
      }
      out.push({ relativePath: expected.relativePath, kind: 'removed' });
      continue;
    }
    if (actual.sizeBytes !== expected.sizeBytes) {
      out.push({
        relativePath: expected.relativePath,
        kind: 'size-changed',
        detail: `${expected.sizeBytes}B → ${actual.sizeBytes}B`,
      });
    } else if (
      expected.sha256 !== undefined &&
      sha256Hex(actual.contents) !== expected.sha256
    ) {
      // Same byte count, different bytes: only the persisted digest catches
      // this. Legacy plans without `sha256` skip the check (size-only).
      out.push({
        relativePath: expected.relativePath,
        kind: 'content-changed',
        detail: 'body digest mismatch (same size, different content)',
      });
    }
  }
  for (const [key, actual] of freshByKey) {
    if (!expectedByKey.has(key)) {
      // Only surface as `added` if the same-path expected didn't already
      // produce a type-changed / operation-changed diagnostic above.
      const samePathExpected = saved.expectedChanges.some(
        (e) => e.relativePath === actual.relativePath,
      );
      if (!samePathExpected) {
        out.push({ relativePath: actual.relativePath, kind: 'added' });
      }
    }
  }
  return out;
}

/**
 * Stable, canonical fingerprint for a plan operation. Two semantically
 * equal operations on the same file produce the same fingerprint; reordering
 * independent ops keeps each one's fingerprint stable.
 */
function opFingerprint(
  op: IPlannedOperation | undefined,
  fallbackType: string,
): string {
  if (!op) return `legacy:${fallbackType}`;
  // The canonical-JSON encoding sorts keys and ignores undefined values, so
  // the resulting hash is deterministic.
  return canonicalOpString(op);
}

function canonicalOpString(op: IPlannedOperation): string {
  return JSON.stringify(canon(op));
}

/**
 * Structural equality on operations. JSON round-trip; cheap and deterministic.
 */
function operationsEqual(a: IPlannedOperation, b: IPlannedOperation): boolean {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/**
 * Folder-op divergence. Returns an empty array when saved and live
 * folder ops match (by kind+targetPath+newPath).
 */
export function diffPlanFolderOps(
  saved: ISavedPlan,
  liveFolderOps: readonly ISavedPlanFolderOp[],
): IPlanDiff[] {
  const out: IPlanDiff[] = [];
  const savedOps = saved.folderOps ?? [];
  const key = (op: ISavedPlanFolderOp): string =>
    `${op.kind}:${op.targetPath}:${op.newPath ?? ''}`;
  const savedByKey = new Map<string, ISavedPlanFolderOp>();
  for (const o of savedOps) savedByKey.set(key(o), o);
  const liveByKey = new Map<string, ISavedPlanFolderOp>();
  for (const o of liveFolderOps) liveByKey.set(key(o), o);

  for (const [k, savedOp] of savedByKey) {
    if (!liveByKey.has(k)) {
      out.push({
        relativePath: savedOp.targetPath,
        kind: 'removed',
        detail: `folder-op ${savedOp.kind}`,
      });
    }
  }
  for (const [k, liveOp] of liveByKey) {
    if (!savedByKey.has(k)) {
      out.push({
        relativePath: liveOp.targetPath,
        kind: 'added',
        detail: `folder-op ${liveOp.kind}`,
      });
    }
  }
  return out;
}

function canon(op: IPlannedOperation): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(op).sort()) {
    const v = (op as unknown as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}
