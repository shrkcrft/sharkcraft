export var KnowledgeType;
(function (KnowledgeType) {
    KnowledgeType["Rule"] = "rule";
    KnowledgeType["Path"] = "path";
    KnowledgeType["Template"] = "template";
    KnowledgeType["Architecture"] = "architecture";
    KnowledgeType["Technical"] = "technical";
    KnowledgeType["Business"] = "business";
    KnowledgeType["Command"] = "command";
    KnowledgeType["Environment"] = "environment";
    KnowledgeType["Dependency"] = "dependency";
    KnowledgeType["Feature"] = "feature";
    KnowledgeType["Task"] = "task";
    KnowledgeType["Warning"] = "warning";
    KnowledgeType["Decision"] = "decision";
    KnowledgeType["Convention"] = "convention";
    KnowledgeType["Workflow"] = "workflow";
    KnowledgeType["Testing"] = "testing";
    KnowledgeType["Security"] = "security";
    KnowledgeType["Deployment"] = "deployment";
    KnowledgeType["Integration"] = "integration";
    KnowledgeType["Custom"] = "custom";
})(KnowledgeType || (KnowledgeType = {}));
export const ALL_KNOWLEDGE_TYPES = Object.freeze(Object.values(KnowledgeType));
export function isKnowledgeType(value) {
    return typeof value === 'string' && ALL_KNOWLEDGE_TYPES.includes(value);
}
