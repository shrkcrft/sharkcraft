import type { ISharkCraftPlugin } from './sharkcraft-plugin.ts';

export interface IMcpToolRegistration {
  name: string;
  description: string;
}

export interface IMcpToolPlugin extends ISharkCraftPlugin {
  readonly tools: readonly IMcpToolRegistration[];
}
