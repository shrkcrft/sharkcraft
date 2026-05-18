import type { ITemplateDefinition, ITemplateFile } from './template-definition.ts';
import type { TemplateVariableValues } from './template-variable.ts';
export interface IRenderedTemplate {
    templateId: string;
    files: ITemplateFile[];
    postGenerationNotes: readonly string[];
}
export declare function renderTemplate(template: ITemplateDefinition, values: TemplateVariableValues): IRenderedTemplate;
//# sourceMappingURL=template-renderer.d.ts.map