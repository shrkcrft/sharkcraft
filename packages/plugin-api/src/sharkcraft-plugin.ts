export interface ISharkCraftPluginContext {
  readonly cwd: string;
  readonly projectRoot: string;
  /** Free-form bag for cross-plugin data — do not abuse. */
  readonly bag: Map<string, unknown>;
}

export interface ISharkCraftPlugin {
  readonly id: string;
  readonly name: string;
  readonly version?: string;
  init?(context: ISharkCraftPluginContext): void | Promise<void>;
}
