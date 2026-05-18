import type { IKnowledgeEntry } from '../model/knowledge-entry.ts';
export interface FormatEntryOptions {
    includeExamples?: boolean;
    includeContent?: boolean;
    includeMetadata?: boolean;
    maxContentChars?: number;
}
export declare function formatEntryCompact(entry: IKnowledgeEntry): string;
export declare function formatEntryFull(entry: IKnowledgeEntry, options?: FormatEntryOptions): string;
//# sourceMappingURL=knowledge-formatter.d.ts.map