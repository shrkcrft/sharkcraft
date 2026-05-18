import type { ISharkCraftPlugin } from './sharkcraft-plugin.ts';

export interface IGeneratorPlugin extends ISharkCraftPlugin {
  /** Returns generator IDs this plugin provides. */
  listGeneratorIds(): readonly string[];
}
