import { OverwriteStrategy } from './overwrite-strategy.ts';
import { FileChangeType, type IFileChange } from './file-change.ts';
export interface IConflictDecision {
    type: FileChangeType;
    reason: string;
}
export declare function decideForExisting(strategy: OverwriteStrategy, existingContent: string, newContent: string): IConflictDecision;
export declare function summarizeConflicts(changes: readonly IFileChange[]): {
    hasConflicts: boolean;
    count: number;
};
//# sourceMappingURL=conflict-handler.d.ts.map