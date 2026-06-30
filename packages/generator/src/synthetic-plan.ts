/**
 * Synthetic plan evaluation.
 *
 * Some plans (e.g. plugin-lifecycle rename/remove) are produced by code that
 * is not a template — there is nothing to "regenerate" against. They carry
 * their structural intent in `ISavedPlan.expectedChanges[].operation` plus
 * `ISavedPlan.folderOps[]`.
 *
 * `evaluateSavedPlanInPlace` evaluates every operation against the live file
 * system and builds an `IGenerationPlan` shaped like a normal one so the
 * apply pipeline can write the resulting changes through the same path.
 *
 * Synthetic plans are identified by a `__`-prefixed templateId so existing
 * template-driven plans are unaffected.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { safeResolveTargetPath, UnsafeTargetPathError } from '@shrkcrft/core';
import { evaluatePlannedChange, type IPlannedOperation } from './planned-change.ts';
import { FileChangeType, type IFileChange } from './file-change.ts';
import type { IGenerationPlan } from './generation-plan.ts';
import type { ISavedPlan } from './saved-plan.ts';

export const SYNTHETIC_TEMPLATE_PREFIX = '__';

export function isSyntheticTemplateId(templateId: string): boolean {
  return templateId.startsWith(SYNTHETIC_TEMPLATE_PREFIX);
}

export function evaluateSavedPlanInPlace(
  plan: ISavedPlan,
  projectRoot: string,
): IGenerationPlan {
  const changes: IFileChange[] = [];
  const warnings: string[] = [];
  let hasConflicts = false;
  const expected = plan.expectedChanges ?? [];
  // Per-file content overlay so MULTIPLE ops on the SAME file COMPOSE: each op
  // sees the cumulative result of the prior ops on that path rather than the
  // original on-disk bytes. Mirrors the template path in dry-run.ts. Without
  // it, [append A, append B] loses A (the writer's last same-path write
  // clobbers earlier ones) and create-then-modify on one NEW path
  // false-conflicts (op2 reads stale disk). Keyed by absolute path → the
  // cumulative content after the prior op(s).
  const overlay = new Map<string, string>();
  for (const e of expected) {
    if (!e.operation) {
      // Without an operation we cannot reconstruct contents — surface as
      // conflict so apply refuses the write. This is the safe default for
      // synthetic plans missing intent.
      changes.push({
        type: FileChangeType.Conflict,
        absolutePath: nodePath.resolve(projectRoot, e.relativePath),
        relativePath: e.relativePath,
        contents: '',
        reason: 'synthetic-plan: expected change has no operation intent',
        sizeBytes: 0,
      });
      hasConflicts = true;
      continue;
    }
    const change = applyOperation(projectRoot, e.relativePath, e.operation, overlay);
    if (change.type === FileChangeType.Conflict) hasConflicts = true;
    changes.push(change);
  }
  const out: IGenerationPlan = {
    templateId: plan.templateId,
    templateName: plan.templateId,
    changes,
    totalFiles: changes.length,
    hasConflicts,
    warnings,
    postGenerationNotes: [],
  };
  if (plan.folderOps && plan.folderOps.length > 0) {
    out.folderOps = plan.folderOps;
  }
  return out;
}

function applyOperation(
  projectRoot: string,
  relativePath: string,
  operation: IPlannedOperation,
  overlay: Map<string, string>,
): IFileChange {
  // Route through the single generator chokepoint instead of a bare resolve, so
  // a traversal / absolute `relativePath` in a hand-crafted or tampered plan
  // can't write OUTSIDE the project root. An unsafe path becomes a Conflict,
  // which writeSyntheticPlan refuses (matching the template path in dry-run.ts).
  let safe: ReturnType<typeof safeResolveTargetPath>;
  try {
    safe = safeResolveTargetPath(relativePath, projectRoot);
  } catch (e) {
    const pathErr = e as UnsafeTargetPathError;
    return {
      type: FileChangeType.Conflict,
      absolutePath: pathErr.rawPath,
      relativePath: pathErr.rawPath,
      contents: '',
      reason: `Refused unsafe target path (${pathErr.code}): ${pathErr.message}`,
      sizeBytes: 0,
    };
  }
  // Prefer the overlay (the cumulative result of prior same-file ops) over the
  // on-disk bytes so op N sees the result of ops 1..N-1. Falls back to the live
  // file, then to absent (`null`) for a brand-new path.
  const existing = overlay.has(safe.absolutePath)
    ? (overlay.get(safe.absolutePath) ?? null)
    : existsSync(safe.absolutePath)
      ? readFileSync(safe.absolutePath, 'utf8')
      : null;
  const result = evaluatePlannedChange({
    change: { targetPath: safe.relativePath, operation },
    absolutePath: safe.absolutePath,
    relativePath: safe.relativePath,
    existing,
  });
  // Record the cumulative content (Skip/Conflict carry the unchanged bytes,
  // which is exactly what a later op on the same file should see).
  overlay.set(safe.absolutePath, result.contents);
  return result;
}

/**
 * Write evaluated changes from a synthetic plan directly. The caller
 * is responsible for verifying signature / divergence / folder-op safety
 * before invoking this.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { AppErrorImpl, ERROR_CODES, err, ok, type AppError, type Result } from '@shrkcrft/core';
import type { IGenerationSummary } from './generation-plan.ts';

export interface ISyntheticWriteResult {
  summary: IGenerationSummary;
  written: readonly IFileChange[];
}

/**
 * A CCR retrieval marker (`<<ccr:<hex>…>>`) is a pointer into the compress
 * cache — a LOSSY/compressed view, never apply-grade source. If one ever
 * reaches a write (e.g. a compressed diff fed into a `create`/`replace` op), it
 * would corrupt the file. This detector enforces, at the write chokepoint, the
 * invariant that the compression layer only documents in a comment.
 */
const CCR_MARKER_RE = /<<ccr:[0-9a-f]{8,}/;

export function writeSyntheticPlan(
  plan: IGenerationPlan,
): Result<ISyntheticWriteResult, AppError> {
  if (plan.hasConflicts) {
    return err(
      new AppErrorImpl(
        ERROR_CODES.TARGET_FILE_EXISTS,
        'Synthetic plan refused: conflicts present',
        { details: { conflicts: plan.changes.filter((c) => c.type === FileChangeType.Conflict) } },
      ),
    );
  }
  // Refuse the WHOLE plan if any writeable change carries a CCR marker — a
  // compressed/lossy blob must never be written as source.
  for (const change of plan.changes) {
    if (!isWriteableSyntheticChange(change.type)) continue;
    if (CCR_MARKER_RE.test(change.contents)) {
      return err(
        new AppErrorImpl(
          ERROR_CODES.INVALID_INPUT,
          `Refused to write ${change.relativePath}: contents carry a <<ccr:…>> marker (a compressed/lossy blob is not apply-grade source).`,
          { details: { path: change.relativePath } },
        ),
      );
    }
  }
  // Compose multiple ops on the SAME path into ONE write. `evaluateSavedPlanInPlace`
  // threads an overlay, so the LAST writeable change for a path already carries
  // the cumulative result of every prior same-path op (any trailing Skip leaves
  // those bytes unchanged). Writing that once — instead of every op's contents
  // in order, last-write-wins — avoids redundant writes and keeps the success
  // count honest: `written` and `summary.written` count DISTINCT paths.
  const lastWriteableByPath = new Map<string, IFileChange>();
  const skipPaths = new Set<string>();
  for (const change of plan.changes) {
    if (isWriteableSyntheticChange(change.type)) {
      lastWriteableByPath.set(change.absolutePath, change);
    } else if (change.type === FileChangeType.Skip) {
      skipPaths.add(change.absolutePath);
    }
  }
  const written: IFileChange[] = [];
  let totalBytes = 0;
  for (const [absolutePath, change] of lastWriteableByPath) {
    try {
      mkdirSync(nodePath.dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, change.contents, 'utf8');
      written.push(change);
      totalBytes += change.sizeBytes;
    } catch (e) {
      return err(
        new AppErrorImpl(
          ERROR_CODES.FILE_WRITE_ERROR,
          `Failed to write ${absolutePath}`,
          { details: { path: absolutePath }, cause: e },
        ),
      );
    }
  }
  // A path counts as skipped only when EVERY op on it resolved to Skip (a path
  // that was also written is not a skip).
  let skipped = 0;
  for (const p of skipPaths) {
    if (!lastWriteableByPath.has(p)) skipped += 1;
  }
  return ok({
    summary: { written: written.length, skipped, conflicts: 0, totalBytes },
    written,
  });
}

function isWriteableSyntheticChange(type: FileChangeType): boolean {
  switch (type) {
    case FileChangeType.Create:
    case FileChangeType.Update:
    case FileChangeType.Append:
    case FileChangeType.InsertAfter:
    case FileChangeType.InsertBefore:
    case FileChangeType.Replace:
    case FileChangeType.Export:
      return true;
    default:
      return false;
  }
}
