import type { IRenderedTemplate } from './template-renderer.ts';
import type { ITemplateDefinition } from './template-definition.ts';
import { type TemplateVariableValues, type IVariableValidationResult } from './template-variable.ts';
export interface ITemplatePreview {
    template: ITemplateDefinition;
    validation: IVariableValidationResult;
    rendered: IRenderedTemplate | null;
}
export declare function previewTemplate(template: ITemplateDefinition, values: TemplateVariableValues): ITemplatePreview;
//# sourceMappingURL=template-preview.d.ts.map