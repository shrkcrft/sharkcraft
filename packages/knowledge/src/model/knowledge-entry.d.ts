import type { KnowledgeType } from './knowledge-type.ts';
import type { KnowledgePriority } from './knowledge-priority.ts';
export interface IKnowledgeExample {
    title?: string;
    description?: string;
    code?: string;
    language?: string;
}
export interface IKnowledgeSource {
    /** Originating file path or URL. */
    origin?: string;
    /** Optional identifier of the loader that produced this entry. */
    loader?: string;
}
export interface IKnowledgeEntry {
    id: string;
    title: string;
    type: KnowledgeType | string;
    priority: KnowledgePriority | string;
    scope: readonly string[];
    tags: readonly string[];
    appliesWhen: readonly string[];
    content: string;
    summary?: string;
    examples?: readonly IKnowledgeExample[];
    related?: readonly string[];
    source?: IKnowledgeSource;
    metadata?: Readonly<Record<string, unknown>>;
}
//# sourceMappingURL=knowledge-entry.d.ts.map