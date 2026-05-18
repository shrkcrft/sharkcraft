import type { IKnowledgeEntry } from '../model/knowledge-entry.ts';
import type { IKnowledgeQuery } from '../model/knowledge-query.ts';
import type { IKnowledgeSearchResult } from '../model/knowledge-search-result.ts';
import { KnowledgeIndex } from '../index/knowledge-index.ts';

export function searchKnowledge(
  entries: readonly IKnowledgeEntry[],
  query: IKnowledgeQuery,
): IKnowledgeSearchResult[] {
  const index = new KnowledgeIndex(entries);
  return index.search(query);
}
