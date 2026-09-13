import type { IRejectedEntry } from '@shrkcrft/core';
import type { IKnowledgeEntry } from '../model/knowledge-entry.ts';

export interface ILoadedKnowledge {
  entries: IKnowledgeEntry[];
  warnings: string[];
  sourceFiles: string[];
  /**
   * Entries the file declared that the loader refused (round 12, 12.1) — the
   * TypeScript loader per export; the Markdown loader refuses its one entry
   * when the frontmatter cannot be read as declared (round 15: a parse error, a
   * field of the wrong shape, a `references:` item it does not take).
   */
  rejected?: IRejectedEntry[];
}

export interface IKnowledgeLoader {
  load(filePath: string): Promise<ILoadedKnowledge>;
  canLoad(filePath: string): boolean;
}
