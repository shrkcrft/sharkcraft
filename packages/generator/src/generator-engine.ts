import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  AppErrorImpl,
  ERROR_CODES,
  err,
  ok,
  type AppError,
  type Result,
} from '@shrkcrft/core';
import type { ITemplateDefinition } from '@shrkcrft/templates';
import type { IGenerationRequest } from './generation-request.ts';
import type { IGenerationPlan, IGenerationSummary } from './generation-plan.ts';
import { planGeneration } from './dry-run.ts';
import { FileChangeType, type IFileChange } from './file-change.ts';

export interface IGenerationResult {
  plan: IGenerationPlan;
  summary: IGenerationSummary;
  written: readonly IFileChange[];
}

export function generate(
  template: ITemplateDefinition,
  request: IGenerationRequest,
): Result<IGenerationResult, AppError> {
  const dryRun = planGeneration(template, request);
  const plan = dryRun.plan;

  if (!request.write) {
    return ok({
      plan,
      summary: {
        written: 0,
        skipped: plan.changes.filter((c) => c.type === FileChangeType.Skip).length,
        conflicts: plan.changes.filter((c) => c.type === FileChangeType.Conflict).length,
        totalBytes: 0,
      },
      written: [],
    });
  }

  if (plan.hasConflicts) {
    return err(
      new AppErrorImpl(
        ERROR_CODES.TARGET_FILE_EXISTS,
        'Generation refused: plan has conflicts (use --force / different overwrite strategy)',
        { details: { conflicts: plan.changes.filter((c) => c.type === FileChangeType.Conflict) } },
      ),
    );
  }

  const written: IFileChange[] = [];
  let totalBytes = 0;
  let skipped = 0;

  for (const change of plan.changes) {
    if (change.type === FileChangeType.Skip) {
      skipped += 1;
      continue;
    }
    if (isWriteableChange(change.type)) {
      try {
        mkdirSync(dirname(change.absolutePath), { recursive: true });
        writeFileSync(change.absolutePath, change.contents, 'utf8');
        written.push(change);
        totalBytes += change.sizeBytes;
      } catch (e) {
        return err(
          new AppErrorImpl(
            ERROR_CODES.FILE_WRITE_ERROR,
            `Failed to write ${change.absolutePath}`,
            { details: { path: change.absolutePath }, cause: e },
          ),
        );
      }
    }
  }

  return ok({
    plan,
    summary: { written: written.length, skipped, conflicts: 0, totalBytes },
    written,
  });
}

/**
 * Every kind whose evaluation produces final-byte `contents` that must be
 * written to disk. Skip + Conflict are explicitly excluded.
 */
function isWriteableChange(type: FileChangeType): boolean {
  switch (type) {
    case FileChangeType.Create:
    case FileChangeType.Update:
    case FileChangeType.Append:
    case FileChangeType.InsertAfter:
    case FileChangeType.InsertBefore:
    case FileChangeType.Replace:
    case FileChangeType.Export:
      return true;
    case FileChangeType.Skip:
    case FileChangeType.Conflict:
      return false;
    case FileChangeType.RenameFolder:
    case FileChangeType.DeleteFolder:
      // Folder ops require dedicated apply-time handling; the file-byte
      // writer never produces them. apply rejects them unless `--allow-folder-ops`
      // and the safety check is green.
      return false;
  }
}
