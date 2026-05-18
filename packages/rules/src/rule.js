import { defineKnowledgeEntry, KnowledgeType } from '@shrkcrft/knowledge';
export function defineRule(input) {
    return defineKnowledgeEntry({
        ...input,
        type: input.type ?? KnowledgeType.Rule,
    });
}
