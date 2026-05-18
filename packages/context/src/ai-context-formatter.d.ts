import type { IKnowledgeEntry } from '@shrkcrft/knowledge';
export interface FormatEntryOptions {
    includeExamples?: boolean;
    maxContentChars?: number;
}
export declare function formatEntryForContext(entry: IKnowledgeEntry, options?: FormatEntryOptions): string;
export declare function formatSectionBody(entries: readonly IKnowledgeEntry[], options?: FormatEntryOptions): string;
//# sourceMappingURL=ai-context-formatter.d.ts.map