import type { IRejectedEntry } from '@shrkcrft/core';
import type { IKnowledgeEntry } from '../model/knowledge-entry.ts';

export interface ILoadedKnowledge {
  entries: IKnowledgeEntry[];
  warnings: string[];
  sourceFiles: string[];
  /**
   * Entries the file declared that the loader refused (round 12, 12.1) — set
   * by the TypeScript loader; a markdown file is one entry and refuses none.
   */
  rejected?: IRejectedEntry[];
}

export interface IKnowledgeLoader {
  load(filePath: string): Promise<ILoadedKnowledge>;
  canLoad(filePath: string): boolean;
}
