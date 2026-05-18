import type { IKnowledgeEntry } from '@shrkcrft/knowledge';
import type { IContextRequest } from './context-request.ts';
export interface SelectedEntries {
    rules: IKnowledgeEntry[];
    paths: IKnowledgeEntry[];
    templates: IKnowledgeEntry[];
    architecture: IKnowledgeEntry[];
    technical: IKnowledgeEntry[];
    warnings: IKnowledgeEntry[];
    commands: IKnowledgeEntry[];
    testing: IKnowledgeEntry[];
    security: IKnowledgeEntry[];
    docs: IKnowledgeEntry[];
    tasks: IKnowledgeEntry[];
}
export declare function selectRelevantEntries(allEntries: readonly IKnowledgeEntry[], request: IContextRequest, limitPerSection?: number): SelectedEntries;
//# sourceMappingURL=relevance-selector.d.ts.map