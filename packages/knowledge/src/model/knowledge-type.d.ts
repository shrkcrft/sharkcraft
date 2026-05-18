export declare enum KnowledgeType {
    Rule = "rule",
    Path = "path",
    Template = "template",
    Architecture = "architecture",
    Technical = "technical",
    Business = "business",
    Command = "command",
    Environment = "environment",
    Dependency = "dependency",
    Feature = "feature",
    Task = "task",
    Warning = "warning",
    Decision = "decision",
    Convention = "convention",
    Workflow = "workflow",
    Testing = "testing",
    Security = "security",
    Deployment = "deployment",
    Integration = "integration",
    Custom = "custom"
}
export declare const ALL_KNOWLEDGE_TYPES: readonly KnowledgeType[];
export declare function isKnowledgeType(value: unknown): value is KnowledgeType;
//# sourceMappingURL=knowledge-type.d.ts.map