import type { IRenderedTemplate } from './template-renderer.ts';
import type { ITemplateDefinition } from './template-definition.ts';
import {
  validateTemplateVariables,
  type TemplateVariableValues,
  type IVariableValidationResult,
} from './template-variable.ts';
import { renderTemplate } from './template-renderer.ts';

export interface ITemplatePreview {
  template: ITemplateDefinition;
  validation: IVariableValidationResult;
  rendered: IRenderedTemplate | null;
}

export function previewTemplate(
  template: ITemplateDefinition,
  values: TemplateVariableValues,
): ITemplatePreview {
  const validation = validateTemplateVariables(template.variables, values);
  if (!validation.valid) {
    return { template, validation, rendered: null };
  }
  const rendered = renderTemplate(template, validation.resolved);
  return { template, validation, rendered };
}
