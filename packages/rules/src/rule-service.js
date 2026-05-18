import { KnowledgeIndex, KnowledgeType } from '@shrkcrft/knowledge';
export class RuleService {
    index;
    constructor(entries) {
        this.index = new KnowledgeIndex(entries);
    }
    list() {
        return this.index.filter((e) => String(e.type) === KnowledgeType.Rule);
    }
    get(id) {
        const entry = this.index.get(id);
        if (!entry || String(entry.type) !== KnowledgeType.Rule)
            return null;
        return entry;
    }
    search(query) {
        const results = this.index.search({
            query: query.task,
            types: [KnowledgeType.Rule],
            scope: query.scope,
            tags: query.tags,
            appliesWhen: query.appliesWhen,
            minPriority: query.minPriority,
            limit: query.limit,
        });
        return results.map((r) => r.entry);
    }
    getRelevant(task, options = {}) {
        return this.search({ ...options, task, limit: options.limit ?? 10 });
    }
}
