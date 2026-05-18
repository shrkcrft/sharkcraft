import { defineKnowledgeEntry, KnowledgeType, } from '@shrkcrft/knowledge';
export function definePathConvention(input) {
    const content = input.content ??
        `${input.description ?? input.title}\nCanonical path: ${input.path}`;
    const entry = defineKnowledgeEntry({
        ...input,
        type: KnowledgeType.Path,
        content,
        metadata: {
            ...(input.metadata ?? {}),
            path: input.path,
            description: input.description,
        },
    });
    return entry;
}
