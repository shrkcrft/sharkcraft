import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IPreset } from '../model/preset.ts';
import {
  synthesizePresetFiles,
  synthesizeResolvedPresetFiles,
  type ISynthesizedFile,
} from '../emit/synthesize-files.ts';
import type { IResolvedPreset } from '../registry/resolve-preset.ts';

export interface IPresetApplyPlanEntry {
  /** Absolute target path inside the project. */
  targetPath: string;
  /** Path relative to project root. */
  relPath: string;
  status: 'create' | 'skip-existing' | 'overwrite-with-force' | 'merge-additive';
  content: string;
  kind: ISynthesizedFile['kind'];
}

export interface IPresetApplyPlan {
  presetId: string;
  sharkcraftDir: string;
  entries: IPresetApplyPlanEntry[];
  warnings: string[];
}

export interface IPreviewOptions {
  /** Absolute project root. */
  projectRoot: string;
  /** Force overwriting existing files. */
  force?: boolean;
  /** Append to existing files where possible (knowledge/rules/paths/templates/pipelines). */
  merge?: boolean;
  /** Override the sharkcraft directory name (default: "sharkcraft"). */
  sharkcraftDirName?: string;
}

const MERGABLE_KINDS = new Set([
  'knowledge',
  'rules',
  'paths',
  'templates',
  'pipelines',
]);

/**
 * Compute the plan for applying a preset against `projectRoot`. Pure I/O on
 * read; never writes. Caller is responsible for executing the plan via
 * {@link applyPlan} (or just printing it).
 */
export function previewPresetApplication(
  preset: IPreset,
  options: IPreviewOptions,
): IPresetApplyPlan {
  return previewFromSynthesized(preset.id, synthesizePresetFiles(preset), options);
}

/**
 * Same as {@link previewPresetApplication} but operating on a flattened
 * (composition-resolved) preset. Use this whenever composition matters —
 * which is the common case once `composes: [...]` is in play.
 */
export function previewResolvedPresetApplication(
  resolved: IResolvedPreset,
  options: IPreviewOptions,
): IPresetApplyPlan {
  return previewFromSynthesized(
    resolved.rootId,
    synthesizeResolvedPresetFiles(resolved),
    options,
  );
}

function previewFromSynthesized(
  presetId: string,
  synthesized: readonly ISynthesizedFile[],
  options: IPreviewOptions,
): IPresetApplyPlan {
  const sharkcraftDir = nodePath.join(
    options.projectRoot,
    options.sharkcraftDirName ?? 'sharkcraft',
  );
  const entries: IPresetApplyPlanEntry[] = [];
  const warnings: string[] = [];

  for (const file of synthesized) {
    const targetPath = nodePath.join(sharkcraftDir, file.path);
    const relPath = nodePath.relative(options.projectRoot, targetPath);
    let status: IPresetApplyPlanEntry['status'] = 'create';
    if (existsSync(targetPath)) {
      if (options.force) {
        status = 'overwrite-with-force';
      } else if (options.merge && MERGABLE_KINDS.has(file.kind)) {
        status = 'merge-additive';
      } else {
        status = 'skip-existing';
        warnings.push(`exists, skipping: ${relPath} (use --force or --merge)`);
      }
    }
    entries.push({
      targetPath,
      relPath,
      status,
      content: file.content,
      kind: file.kind,
    });
  }

  return { presetId, sharkcraftDir, entries, warnings };
}

/**
 * Execute a plan. Writes files according to each entry's status. Returns the
 * list of relPaths actually written.
 *
 * For `merge-additive`, we append the new content under a generated banner.
 * No semantic re-parsing is performed — review the result.
 */
export function applyPresetPlan(plan: IPresetApplyPlan): {
  written: string[];
  skipped: string[];
} {
  const written: string[] = [];
  const skipped: string[] = [];
  for (const entry of plan.entries) {
    if (entry.status === 'skip-existing') {
      skipped.push(entry.relPath);
      continue;
    }
    const dir = nodePath.dirname(entry.targetPath);
    mkdirSync(dir, { recursive: true });
    if (entry.status === 'merge-additive' && existsSync(entry.targetPath)) {
      const previous = readFileSync(entry.targetPath, 'utf8');
      const banner = `\n\n// --- merged from preset ${plan.presetId} ---\n`;
      writeFileSync(entry.targetPath, previous + banner + entry.content, 'utf8');
    } else {
      writeFileSync(entry.targetPath, entry.content, 'utf8');
    }
    written.push(entry.relPath);
  }
  return { written, skipped };
}
