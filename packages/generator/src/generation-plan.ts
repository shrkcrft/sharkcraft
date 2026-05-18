import type { IFileChange } from './file-change.ts';
import type { ISavedPlanFolderOp } from './saved-plan.ts';

export interface IGenerationPlan {
  templateId: string;
  templateName: string;
  changes: readonly IFileChange[];
  totalFiles: number;
  hasConflicts: boolean;
  warnings: readonly string[];
  postGenerationNotes: readonly string[];
  /**
   * Optional folder operations attached to the plan. Carried verbatim
   * into saved plans and executed via `applyFolderOps()` during `shrk apply`
   * when explicit allow flags are present.
   */
  folderOps?: readonly ISavedPlanFolderOp[];
}

export interface IGenerationSummary {
  written: number;
  skipped: number;
  conflicts: number;
  totalBytes: number;
}
