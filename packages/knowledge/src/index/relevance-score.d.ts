import type { IKnowledgeEntry } from '../model/knowledge-entry.ts';
import type { IKnowledgeQuery } from '../model/knowledge-query.ts';
import type { IKnowledgeMatchReason } from '../model/knowledge-search-result.ts';
export interface ScoredMatch {
    score: number;
    reasons: IKnowledgeMatchReason[];
}
export declare function scoreEntry(entry: IKnowledgeEntry, query: IKnowledgeQuery): ScoredMatch;
//# sourceMappingURL=relevance-score.d.ts.map