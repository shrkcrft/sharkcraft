import { OverwriteStrategy } from "./overwrite-strategy.js";
import { FileChangeType } from "./file-change.js";
export function decideForExisting(strategy, existingContent, newContent) {
    if (existingContent === newContent) {
        return { type: FileChangeType.Skip, reason: 'No changes (identical contents)' };
    }
    switch (strategy) {
        case OverwriteStrategy.Overwrite:
            return { type: FileChangeType.Update, reason: 'overwrite strategy: overwrite' };
        case OverwriteStrategy.Ask:
            return { type: FileChangeType.Conflict, reason: 'overwrite strategy: ask (requires user)' };
        case OverwriteStrategy.MergeLater:
            return {
                type: FileChangeType.Conflict,
                reason: 'overwrite strategy: merge-later (would conflict)',
            };
        case OverwriteStrategy.Never:
        default:
            return { type: FileChangeType.Conflict, reason: 'overwrite strategy: never (file exists)' };
    }
}
export function summarizeConflicts(changes) {
    const count = changes.filter((c) => c.type === FileChangeType.Conflict).length;
    return { hasConflicts: count > 0, count };
}
