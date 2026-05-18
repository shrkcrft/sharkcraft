import type { IKnowledgeEntry } from './knowledge-entry.ts';

export interface IKnowledgeMatchReason {
  field: string;
  match: string;
}

export interface IKnowledgeSearchResult {
  entry: IKnowledgeEntry;
  score: number;
  reasons: readonly IKnowledgeMatchReason[];
}
