import type { ISharkCraftPlugin } from './sharkcraft-plugin.ts';

export interface IKnowledgePluginEntry {
  id: string;
  title: string;
  type: string;
  priority: string;
  scope: readonly string[];
  tags: readonly string[];
  appliesWhen: readonly string[];
  content: string;
}

export interface IKnowledgePlugin extends ISharkCraftPlugin {
  readonly entries: readonly IKnowledgePluginEntry[];
}
