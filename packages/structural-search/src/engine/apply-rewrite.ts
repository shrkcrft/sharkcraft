import { readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IRewritePlan } from '../schema/rewrite.ts';

export interface IApplyRewriteOptions {
  projectRoot: string;
  /** When true, just compute what would be written (no fs touch). */
  dryRun?: boolean;
}

export interface IApplyRewriteResult {
  filesChanged: number;
  filesAttempted: number;
  bytesWritten: number;
  /** Files whose pre-existing content didn't match plan.edits[i].before. */
  conflicts: readonly string[];
  diagnostics: readonly string[];
}

/**
 * Apply a rewrite plan to disk.
 *
 * Edits are applied in reverse offset order so earlier offsets stay
 * valid as later edits shrink/grow the file. If the file content has
 * changed since the plan was computed (any edit's `before` no longer
 * matches the text at its position), the whole file is skipped and
 * reported in `conflicts`. This is the safety mechanism — never
 * silently overwrite drifted content.
 *
 * Dry-run mode (`--dry-run`) computes everything except the
 * `writeFileSync`; useful for previewing what `apply` would do.
 */
export function applyRewritePlan(
  plan: IRewritePlan,
  options: IApplyRewriteOptions,
): IApplyRewriteResult {
  let filesChanged = 0;
  let bytesWritten = 0;
  const conflicts: string[] = [];
  const diagnostics: string[] = [];
  for (const f of plan.files) {
    const abs = nodePath.resolve(options.projectRoot, f.path);
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch (e) {
      diagnostics.push(`${f.path}: read failed (${(e as Error).message})`);
      continue;
    }
    // Verify every edit's `before` still matches.
    let drifted = false;
    for (const e of f.edits) {
      const current = text.slice(e.start, e.end);
      if (current !== e.before) {
        drifted = true;
        conflicts.push(f.path);
        diagnostics.push(`${f.path}:${e.line}: expected "${e.before}" at offset ${e.start}, found "${current}" — skipping file`);
        break;
      }
    }
    if (drifted) continue;
    let next = text;
    // Apply in reverse.
    const sorted = [...f.edits].sort((a, b) => b.start - a.start);
    for (const e of sorted) {
      next = next.slice(0, e.start) + e.replacement + next.slice(e.end);
    }
    if (next === text) continue;
    if (!options.dryRun) {
      writeFileSync(abs, next, 'utf8');
      bytesWritten += Buffer.byteLength(next, 'utf8');
    } else {
      bytesWritten += Buffer.byteLength(next, 'utf8');
    }
    filesChanged += 1;
  }
  return {
    filesAttempted: plan.files.length,
    filesChanged,
    bytesWritten,
    conflicts,
    diagnostics,
  };
}
