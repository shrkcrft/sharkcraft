export declare enum KnowledgePriority {
    Critical = "critical",
    High = "high",
    Medium = "medium",
    Low = "low"
}
export declare const PRIORITY_WEIGHTS: Readonly<Record<KnowledgePriority, number>>;
export declare function priorityWeight(priority: KnowledgePriority | undefined): number;
//# sourceMappingURL=knowledge-priority.d.ts.map