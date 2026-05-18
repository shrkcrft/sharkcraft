import { type ITemplateDefinition } from '@shrkcrft/templates';
import type { IGenerationRequest } from './generation-request.ts';
import type { IGenerationPlan } from './generation-plan.ts';
export interface IDryRunResult {
    plan: IGenerationPlan;
    /** True if the plan can be safely written without conflicts. */
    safe: boolean;
}
export declare function planGeneration(template: ITemplateDefinition, request: IGenerationRequest): IDryRunResult;
//# sourceMappingURL=dry-run.d.ts.map