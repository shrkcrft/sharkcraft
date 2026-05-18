import { existsSync } from 'node:fs';
import { type IImportContext, safeImport } from '@shrkcrft/core';
import type { IPreset } from '../model/preset.ts';
import { validatePreset } from '../model/preset.ts';

export interface ILoadedPresetFile {
  source: string;
  presets: IPreset[];
  warnings: string[];
}

export interface ILoadPresetsOptions {
  importContext?: IImportContext;
}

export async function loadPresetsFromFile(
  absPath: string,
  options: ILoadPresetsOptions = {},
): Promise<ILoadedPresetFile> {
  const out: ILoadedPresetFile = { source: absPath, presets: [], warnings: [] };
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
  const candidates =
    pickArray(result.module.default) ?? pickArray(result.module.presets) ?? [];
  for (const candidate of candidates) {
    const v = validatePreset(candidate);
    if (!v.valid) {
      out.warnings.push(
        `${absPath}: skipping invalid preset (${v.issues.map((i) => i.field).join(', ')})`,
      );
      continue;
    }
    out.presets.push(candidate as IPreset);
  }
  return out;
}

function pickArray(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  return null;
}
