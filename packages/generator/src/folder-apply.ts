/**
 * Folder operation applier.
 *
 * Executes `rename-folder` / `delete-folder` operations with strict safety
 * gates. Refuses unsafe paths *before* touching the filesystem. The CLI
 * `shrk apply` command can call this once its plan schema knows how to
 * carry folder ops in a saved plan; today plugin-lifecycle plans pass an
 * `IPluginLifecycleFolderOp[]` directly.
 *
 * Read-only by default; mutates only when `dryRun === false` AND the
 * caller has supplied the explicit allow flags.
 */
import { existsSync, renameSync, rmSync } from 'node:fs';
import * as nodePath from 'node:path';
import { checkFolderOpSafety, FolderOpSafety } from './folder-safety.ts';

export interface IFolderOpInput {
  readonly kind: 'rename-folder' | 'delete-folder';
  readonly targetPath: string;
  readonly newPath?: string;
}

export interface IFolderOpOptions {
  readonly projectRoot: string;
  readonly dryRun?: boolean;
  readonly allowFolderOps?: boolean;
  readonly allowDeleteFolder?: boolean;
}

export interface IFolderOpResult {
  readonly op: IFolderOpInput;
  readonly applied: boolean;
  readonly safety: FolderOpSafety;
  readonly reason?: string;
  readonly absTarget: string;
  readonly absNewPath?: string;
}

export interface IFolderOpApplyReport {
  readonly schema: 'sharkcraft.folder-op-apply/v1';
  readonly projectRoot: string;
  readonly dryRun: boolean;
  readonly applied: readonly IFolderOpResult[];
  readonly rejected: readonly IFolderOpResult[];
}

function resolveAbs(projectRoot: string, p: string): string {
  return nodePath.isAbsolute(p) ? p : nodePath.resolve(projectRoot, p);
}

export function applyFolderOps(
  ops: readonly IFolderOpInput[],
  options: IFolderOpOptions,
): IFolderOpApplyReport {
  const applied: IFolderOpResult[] = [];
  const rejected: IFolderOpResult[] = [];
  const dryRun = options.dryRun !== false; // default true — explicit opt-in to mutate

  for (const op of ops) {
    const safetyOptions: { allowDeleteFolder?: boolean } = {};
    if (options.allowDeleteFolder) safetyOptions.allowDeleteFolder = true;
    const safety = checkFolderOpSafety(
      options.projectRoot,
      op.targetPath,
      op.kind,
      safetyOptions,
    );
    const absTarget = resolveAbs(options.projectRoot, op.targetPath);
    const absNewPath = op.newPath ? resolveAbs(options.projectRoot, op.newPath) : undefined;
    const baseResult: Omit<IFolderOpResult, 'applied'> = {
      op,
      safety: safety.safety,
      ...(safety.reason ? { reason: safety.reason } : {}),
      absTarget,
      ...(absNewPath ? { absNewPath } : {}),
    };

    // 1) Safety must be green.
    if (safety.safety !== FolderOpSafety.Safe) {
      rejected.push({ ...baseResult, applied: false });
      continue;
    }
    // 2) Allow-flag must be present.
    if (!options.allowFolderOps) {
      rejected.push({
        ...baseResult,
        applied: false,
        safety: FolderOpSafety.Unsafe,
        reason: 'Folder op rejected — pass `--allow-folder-ops` to enable.',
      });
      continue;
    }
    // 3) Rename specifics.
    if (op.kind === 'rename-folder') {
      if (!absNewPath) {
        rejected.push({
          ...baseResult,
          applied: false,
          safety: FolderOpSafety.Unsafe,
          reason: 'rename-folder requires `newPath`.',
        });
        continue;
      }
      if (existsSync(absNewPath)) {
        rejected.push({
          ...baseResult,
          applied: false,
          safety: FolderOpSafety.Unsafe,
          reason: `rename-folder destination "${op.newPath}" already exists.`,
        });
        continue;
      }
      if (dryRun) {
        applied.push({ ...baseResult, applied: false });
        continue;
      }
      try {
        renameSync(absTarget, absNewPath);
        applied.push({ ...baseResult, applied: true });
      } catch (e) {
        rejected.push({
          ...baseResult,
          applied: false,
          safety: FolderOpSafety.Unsafe,
          reason: `rename failed: ${(e as Error).message}`,
        });
      }
      continue;
    }
    // 4) Delete specifics — already gated by checkFolderOpSafety via allowDeleteFolder.
    if (op.kind === 'delete-folder') {
      if (dryRun) {
        applied.push({ ...baseResult, applied: false });
        continue;
      }
      try {
        rmSync(absTarget, { recursive: true, force: false });
        applied.push({ ...baseResult, applied: true });
      } catch (e) {
        rejected.push({
          ...baseResult,
          applied: false,
          safety: FolderOpSafety.Unsafe,
          reason: `delete failed: ${(e as Error).message}`,
        });
      }
    }
  }
  return {
    schema: 'sharkcraft.folder-op-apply/v1',
    projectRoot: options.projectRoot,
    dryRun,
    applied,
    rejected,
  };
}
