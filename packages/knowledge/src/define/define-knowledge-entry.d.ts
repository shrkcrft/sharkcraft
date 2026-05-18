import type { IKnowledgeEntry, IKnowledgeExample, IKnowledgeSource } from '../model/knowledge-entry.ts';
export interface DefineKnowledgeInput {
    id: string;
    title: string;
    type: string;
    priority?: string;
    scope?: readonly string[];
    tags?: readonly string[];
    appliesWhen?: readonly string[];
    content: string;
    summary?: string;
    examples?: readonly IKnowledgeExample[];
    related?: readonly string[];
    source?: IKnowledgeSource;
    metadata?: Readonly<Record<string, unknown>>;
}
export declare function defineKnowledgeEntry(input: DefineKnowledgeInput): IKnowledgeEntry;
//# sourceMappingURL=define-knowledge-entry.d.ts.map