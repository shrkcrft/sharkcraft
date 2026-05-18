import { KnowledgePriority } from "../model/knowledge-priority.js";
import { isValidKnowledgeId } from '@shrkcrft/core';
export function defineKnowledgeEntry(input) {
    if (!input.id || typeof input.id !== 'string') {
        throw new Error(`defineKnowledgeEntry: 'id' is required (got ${String(input.id)})`);
    }
    if (!isValidKnowledgeId(input.id)) {
        throw new Error(`defineKnowledgeEntry: 'id' must match /^[a-z0-9]+([.-][a-z0-9]+)*$/ (got "${input.id}")`);
    }
    if (!input.title) {
        throw new Error(`defineKnowledgeEntry: 'title' is required for ${input.id}`);
    }
    if (!input.type) {
        throw new Error(`defineKnowledgeEntry: 'type' is required for ${input.id}`);
    }
    if (typeof input.content !== 'string') {
        throw new Error(`defineKnowledgeEntry: 'content' is required for ${input.id}`);
    }
    return {
        id: input.id,
        title: input.title,
        type: input.type,
        priority: input.priority ?? KnowledgePriority.Medium,
        scope: Object.freeze([...(input.scope ?? [])]),
        tags: Object.freeze([...(input.tags ?? [])]),
        appliesWhen: Object.freeze([...(input.appliesWhen ?? [])]),
        content: input.content,
        summary: input.summary,
        examples: input.examples ? Object.freeze([...input.examples]) : undefined,
        related: input.related ? Object.freeze([...input.related]) : undefined,
        source: input.source,
        metadata: input.metadata,
    };
}
