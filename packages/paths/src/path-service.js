import { KnowledgeIndex, KnowledgeType } from '@shrkcrft/knowledge';
import { selectBestPath } from "./path-selector.js";
export class PathService {
    index;
    constructor(entries) {
        this.index = new KnowledgeIndex(entries);
    }
    list() {
        return this.index
            .filter((e) => String(e.type) === KnowledgeType.Path)
            .map((e) => e);
    }
    get(id) {
        const entry = this.index.get(id);
        if (!entry || String(entry.type) !== KnowledgeType.Path)
            return null;
        return entry;
    }
    search(query) {
        const results = this.index.search({
            query: query.query ?? query.task,
            types: [KnowledgeType.Path],
            scope: query.scope,
            tags: query.tags,
            appliesWhen: query.appliesWhen,
            limit: query.limit,
        });
        return results.map((r) => r.entry);
    }
    findBestForTask(task) {
        return selectBestPath(this.list(), task);
    }
}
