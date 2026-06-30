/**
 * Hard safety gates for folder rename/delete plan operations.
 *
 * Folder ops are preview-only by default. Apply must refuse:
 *   - paths outside the project root
 *   - paths inside `.git`, `node_modules`, home directories
 *   - empty / root / absolute paths
 *   - paths that resolve to the project root itself
 *
 * Read-only safety helpers; no side effects.
 */
import { existsSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import * as nodeOs from 'node:os';
import { pathEscapesRootViaSymlink } from '@shrkcrft/core';

export enum FolderOpSafety {
  Safe = 'safe',
  Unsafe = 'unsafe',
}

export interface IFolderOpSafetyResult {
  readonly safety: FolderOpSafety;
  readonly reason?: string;
}

const FORBIDDEN_SEGMENTS = new Set(['.git', 'node_modules', '.svn', '.hg']);

export function checkFolderOpSafety(
  projectRoot: string,
  target: string,
  kind: 'rename-folder' | 'delete-folder',
  options?: { allowDeleteFolder?: boolean },
): IFolderOpSafetyResult {
  if (!target || target === '/' || target === '.') {
    return { safety: FolderOpSafety.Unsafe, reason: `Target path "${target}" is the project root or empty.` };
  }
  const abs = nodePath.isAbsolute(target) ? target : nodePath.resolve(projectRoot, target);
  const normalisedRoot = nodePath.resolve(projectRoot);
  const home = nodeOs.homedir();
  // Must be inside project root.
  const rel = nodePath.relative(normalisedRoot, abs);
  if (rel.startsWith('..') || nodePath.isAbsolute(rel)) {
    return {
      safety: FolderOpSafety.Unsafe,
      reason: `Target path "${target}" resolves to "${abs}" which is outside the project root "${normalisedRoot}".`,
    };
  }
  // Realpath-aware containment — a lexically-clean path can still traverse an
  // in-root symlink (e.g. `linkdir -> ../outside`) so that `linkdir/secret`
  // physically lives outside the sandbox. A destructive rmSync/renameSync on
  // such a path would corrupt EXTERNAL data while reporting success.
  if (pathEscapesRootViaSymlink(normalisedRoot, abs)) {
    return {
      safety: FolderOpSafety.Unsafe,
      reason: `Target path "${target}" resolves to "${abs}" which is outside the project root (symlink escape).`,
    };
  }
  if (abs === normalisedRoot) {
    return { safety: FolderOpSafety.Unsafe, reason: 'Target path resolves to the project root.' };
  }
  if (abs === home || abs === '/') {
    return { safety: FolderOpSafety.Unsafe, reason: `Target path resolves to "${abs}" — refuses to operate on home/root directories.` };
  }
  for (const seg of abs.split(nodePath.sep)) {
    if (FORBIDDEN_SEGMENTS.has(seg)) {
      return {
        safety: FolderOpSafety.Unsafe,
        reason: `Target path "${target}" contains forbidden segment "${seg}".`,
      };
    }
  }
  if (kind === 'delete-folder' && !options?.allowDeleteFolder) {
    return {
      safety: FolderOpSafety.Unsafe,
      reason: 'delete-folder requires explicit `--allow-delete-folder` flag at apply time.',
    };
  }
  // Existing folder check for rename (must exist).
  if (kind === 'rename-folder' && !existsSync(abs)) {
    return {
      safety: FolderOpSafety.Unsafe,
      reason: `rename-folder target "${target}" does not exist.`,
    };
  }
  if (kind === 'delete-folder' && existsSync(abs)) {
    try {
      const st = statSync(abs);
      if (!st.isDirectory()) {
        return { safety: FolderOpSafety.Unsafe, reason: `delete-folder target "${target}" is not a directory.` };
      }
    } catch {
      // ignore
    }
  }
  return { safety: FolderOpSafety.Safe };
}
