import type { IKnowledgeEntry } from '../model/knowledge-entry.ts';
export interface KnowledgeFilterOptions {
    types?: readonly string[];
    scope?: readonly string[];
    tags?: readonly string[];
    appliesWhen?: readonly string[];
}
export declare function filterKnowledge(entries: readonly IKnowledgeEntry[], options: KnowledgeFilterOptions): IKnowledgeEntry[];
//# sourceMappingURL=knowledge-filter.d.ts.map