import { type AppError, type Result } from '@shrkcrft/core';
import type { IGenerationPlan } from './generation-plan.ts';
export declare const SAVED_PLAN_SCHEMA = "sharkcraft.plan/v1";
export interface ISavedPlan {
    /** Schema marker for forward-compat. */
    schema: typeof SAVED_PLAN_SCHEMA;
    templateId: string;
    /** Primary kebab-case name passed to the template. Optional. */
    name?: string;
    variables: Record<string, string>;
    /** Absolute path of the project root the plan was created against. */
    projectRoot: string;
    /** ISO timestamp of when the plan was saved. */
    createdAt: string;
    /**
     * Optional summary of the plan's expected changes at save time. Used as a
     * sanity check during `shrk apply`; if the live plan diverges, the CLI
     * surfaces a warning before writing.
     */
    expectedChanges?: ReadonlyArray<{
        type: string;
        relativePath: string;
        sizeBytes: number;
    }>;
    /** Optional free-form notes from whoever saved the plan. */
    note?: string;
}
export interface BuildSavedPlanInput {
    templateId: string;
    name?: string;
    variables: Record<string, string>;
    projectRoot: string;
    plan: IGenerationPlan;
    note?: string;
}
export declare function buildSavedPlan(input: BuildSavedPlanInput): ISavedPlan;
export declare function savePlanToFile(plan: ISavedPlan, filePath: string): Result<void, AppError>;
export declare function readPlanFromFile(filePath: string): Result<ISavedPlan, AppError>;
export interface IPlanDiff {
    relativePath: string;
    /** "added" | "removed" | "type-changed" | "size-changed" */
    kind: 'added' | 'removed' | 'type-changed' | 'size-changed';
    detail?: string;
}
/**
 * Compare the saved plan's expected changes with a freshly-computed plan's
 * changes. Returns an empty array when they match.
 */
export declare function diffPlanChanges(saved: ISavedPlan, fresh: IGenerationPlan): IPlanDiff[];
//# sourceMappingURL=saved-plan.d.ts.map