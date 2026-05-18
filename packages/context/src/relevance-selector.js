import { KnowledgeIndex } from '@shrkcrft/knowledge';
const TYPE_BUCKETS = {
    rule: 'rules',
    path: 'paths',
    template: 'templates',
    architecture: 'architecture',
    technical: 'technical',
    warning: 'warnings',
    command: 'commands',
    testing: 'testing',
    security: 'security',
    task: 'tasks',
};
export function selectRelevantEntries(allEntries, request, limitPerSection = 5) {
    const index = new KnowledgeIndex(allEntries);
    const tags = [...(request.tags ?? [])];
    const scope = [...(request.scope ?? [])];
    if (request.framework)
        scope.push(request.framework);
    if (request.area)
        scope.push(request.area);
    const searchAll = index.search({
        query: request.task,
        scope,
        tags,
        appliesWhen: request.appliesWhen,
    });
    const buckets = {
        rules: [],
        paths: [],
        templates: [],
        architecture: [],
        technical: [],
        warnings: [],
        commands: [],
        testing: [],
        security: [],
        docs: [],
        tasks: [],
    };
    for (const r of searchAll) {
        const typeKey = String(r.entry.type).toLowerCase();
        const bucketKey = TYPE_BUCKETS[typeKey];
        if (bucketKey) {
            if (buckets[bucketKey].length < limitPerSection)
                buckets[bucketKey].push(r.entry);
        }
        else if (request.includeDocs) {
            if (buckets.docs.length < limitPerSection)
                buckets.docs.push(r.entry);
        }
    }
    return buckets;
}
