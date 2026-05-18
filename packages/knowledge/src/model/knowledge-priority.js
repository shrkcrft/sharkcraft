export var KnowledgePriority;
(function (KnowledgePriority) {
    KnowledgePriority["Critical"] = "critical";
    KnowledgePriority["High"] = "high";
    KnowledgePriority["Medium"] = "medium";
    KnowledgePriority["Low"] = "low";
})(KnowledgePriority || (KnowledgePriority = {}));
export const PRIORITY_WEIGHTS = Object.freeze({
    [KnowledgePriority.Critical]: 100,
    [KnowledgePriority.High]: 70,
    [KnowledgePriority.Medium]: 40,
    [KnowledgePriority.Low]: 10,
});
export function priorityWeight(priority) {
    return PRIORITY_WEIGHTS[priority ?? KnowledgePriority.Medium];
}
