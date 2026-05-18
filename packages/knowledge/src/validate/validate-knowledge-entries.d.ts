import type { IKnowledgeEntry } from '../model/knowledge-entry.ts';
export interface IKnowledgeValidationIssue {
    /** Stable identifier for the issue category. */
    code: 'missing-id' | 'invalid-id-format' | 'duplicate-id' | 'missing-title' | 'missing-content' | 'missing-type' | 'invalid-type' | 'invalid-priority';
    /** Affected entry id (or '?' if unknown). */
    entryId: string;
    /** Source file path if available. */
    source?: string;
    /** Human-readable message. */
    message: string;
    /** Severity hint. */
    severity: 'error' | 'warning';
}
export interface IKnowledgeValidationResult {
    valid: boolean;
    issues: IKnowledgeValidationIssue[];
    /** Entries with the first-seen winner for each id (duplicates dropped). */
    uniqueEntries: IKnowledgeEntry[];
}
/**
 * Validate a list of knowledge entries. Catches the classic problems:
 *   - missing or malformed id
 *   - duplicate ids (warning — first occurrence wins)
 *   - missing title/content/type
 *   - unknown type (warning — custom types are allowed but get flagged)
 *   - unknown priority (error)
 */
export declare function validateKnowledgeEntries(entries: readonly IKnowledgeEntry[]): IKnowledgeValidationResult;
//# sourceMappingURL=validate-knowledge-entries.d.ts.map