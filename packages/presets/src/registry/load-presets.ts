import { existsSync } from 'node:fs';
import { type IImportContext, type IRejectedEntry, RejectionCause, safeImport } from '@shrkcrft/core';
import type { IPreset } from '../model/preset.ts';
import { validatePreset } from '../model/preset.ts';

export interface ILoadedPresetFile {
  source: string;
  presets: IPreset[];
  warnings: string[];
  /**
   * Presets the file declared that failed `validatePreset` (round 12, 12.1) —
   * each with its position and EVERY failing field, not only a warning string.
   */
  rejected: IRejectedEntry[];
}

export interface ILoadPresetsOptions {
  importContext?: IImportContext;
}

export async function loadPresetsFromFile(
  absPath: string,
  options: ILoadPresetsOptions = {},
): Promise<ILoadedPresetFile> {
  const out: ILoadedPresetFile = { source: absPath, presets: [], warnings: [], rejected: [] };
  if (!existsSync(absPath)) {
    out.warnings.push(`preset file not found: ${absPath}`);
    return out;
  }
  const result = options.importContext
    ? await options.importContext.load<{ default?: unknown; presets?: unknown }>(absPath)
    : await safeImport<{ default?: unknown; presets?: unknown }>(absPath, { skipExistsCheck: true });
  if (!result.ok) {
    const label = result.timedOut ? 'timed out loading presets from' : 'failed to load presets from';
    out.warnings.push(`${label} ${absPath}: ${result.error.message}`);
    return out;
  }
  const fromDefault = pickArray(result.module.default);
  const exportName = fromDefault ? 'default' : 'presets';
  const candidates = fromDefault ?? pickArray(result.module.presets) ?? [];
  candidates.forEach((candidate, index) => {
    const v = validatePreset(candidate);
    if (!v.valid) {
      out.warnings.push(
        `${absPath}: skipping invalid preset (${v.issues.map((i) => i.field).join(', ')})`,
      );
      const id = (candidate as { id?: unknown } | null)?.id;
      out.rejected.push({
        file: absPath,
        index,
        exportName,
        ...(typeof id === 'string' ? { entryId: id } : {}),
        reasons: v.issues.map((i) => `${i.field}: ${i.message}`),
        cause: RejectionCause.Invalid,
      });
      return;
    }
    out.presets.push(candidate as IPreset);
  });
  return out;
}

function pickArray(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  return null;
}
