import type { ISharkCraftPlugin } from './sharkcraft-plugin.ts';

export interface ITemplatePluginTemplate {
  id: string;
  name: string;
  description: string;
}

export interface ITemplatePlugin extends ISharkCraftPlugin {
  readonly templates: readonly ITemplatePluginTemplate[];
}
