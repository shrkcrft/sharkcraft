export interface IKnowledgeQuery {
    /** Free-text query (matched against title/summary/content/tags). */
    query?: string;
    /** Restrict by knowledge type. */
    types?: readonly string[];
    /** Restrict by scope (framework/area). */
    scope?: readonly string[];
    /** Tag filter (AND). */
    tags?: readonly string[];
    /** appliesWhen filter (any-match). */
    appliesWhen?: readonly string[];
    /** Minimum priority threshold. */
    minPriority?: string;
    /** Limit on returned entries. */
    limit?: number;
}
//# sourceMappingURL=knowledge-query.d.ts.map