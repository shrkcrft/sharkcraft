import type { IPreset } from '../model/preset.ts';

export class PresetRegistry {
  private readonly byId = new Map<string, IPreset>();

  constructor(presets: readonly IPreset[] = []) {
    for (const p of presets) this.add(p);
  }

  add(preset: IPreset): void {
    this.byId.set(preset.id, preset);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): IPreset | undefined {
    return this.byId.get(id);
  }

  list(): readonly IPreset[] {
    return [...this.byId.values()];
  }

  size(): number {
    return this.byId.size;
  }
}
