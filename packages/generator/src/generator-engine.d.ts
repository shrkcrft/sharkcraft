import { type AppError, type Result } from '@shrkcrft/core';
import type { ITemplateDefinition } from '@shrkcrft/templates';
import type { IGenerationRequest } from './generation-request.ts';
import type { IGenerationPlan, IGenerationSummary } from './generation-plan.ts';
import { type IFileChange } from './file-change.ts';
export interface IGenerationResult {
    plan: IGenerationPlan;
    summary: IGenerationSummary;
    written: readonly IFileChange[];
}
export declare function generate(template: ITemplateDefinition, request: IGenerationRequest): Result<IGenerationResult, AppError>;
//# sourceMappingURL=generator-engine.d.ts.map