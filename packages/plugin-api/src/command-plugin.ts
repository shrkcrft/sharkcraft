import type { ISharkCraftPlugin } from './sharkcraft-plugin.ts';

export interface ICommandPluginCommand {
  name: string;
  description: string;
  /** Returns exit code: 0 success, non-zero failure. */
  run: (args: readonly string[]) => Promise<number> | number;
}

export interface ICommandPlugin extends ISharkCraftPlugin {
  readonly commands: readonly ICommandPluginCommand[];
}
