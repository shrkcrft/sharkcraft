import type { IFileChange } from './file-change.ts';
export interface IGenerationPlan {
    templateId: string;
    templateName: string;
    changes: readonly IFileChange[];
    totalFiles: number;
    hasConflicts: boolean;
    warnings: readonly string[];
    postGenerationNotes: readonly string[];
}
export interface IGenerationSummary {
    written: number;
    skipped: number;
    conflicts: number;
    totalBytes: number;
}
//# sourceMappingURL=generation-plan.d.ts.map