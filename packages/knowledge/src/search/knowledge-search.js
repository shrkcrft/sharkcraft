import { KnowledgeIndex } from "../index/knowledge-index.js";
export function searchKnowledge(entries, query) {
    const index = new KnowledgeIndex(entries);
    return index.search(query);
}
