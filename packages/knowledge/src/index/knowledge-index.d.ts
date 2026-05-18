import type { IKnowledgeEntry } from '../model/knowledge-entry.ts';
import type { IKnowledgeQuery } from '../model/knowledge-query.ts';
import type { IKnowledgeSearchResult } from '../model/knowledge-search-result.ts';
export declare class KnowledgeIndex {
    private readonly byId;
    private readonly all;
    constructor(entries?: readonly IKnowledgeEntry[]);
    add(entry: IKnowledgeEntry): void;
    has(id: string): boolean;
    get(id: string): IKnowledgeEntry | null;
    list(): readonly IKnowledgeEntry[];
    size(): number;
    filter(predicate: (entry: IKnowledgeEntry) => boolean): IKnowledgeEntry[];
    search(query: IKnowledgeQuery): IKnowledgeSearchResult[];
}
//# sourceMappingURL=knowledge-index.d.ts.map