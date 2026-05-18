import type { IPreset } from '../model/preset.ts';

/** Identity helper for declaring presets with type inference. */
export function definePreset<T extends IPreset>(preset: T): T {
  return preset;
}
