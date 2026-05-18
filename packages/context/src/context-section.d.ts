export interface IContextSection {
    title: string;
    /** Entry IDs included (for traceability). */
    entryIds: readonly string[];
    /** Compact, AI-ready body. */
    body: string;
    /** Approximate token cost. */
    tokens: number;
    /** Marker if section was truncated due to budget. */
    truncated?: boolean;
}
//# sourceMappingURL=context-section.d.ts.map