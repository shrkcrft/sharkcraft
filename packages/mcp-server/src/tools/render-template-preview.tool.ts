import type { IToolDefinition } from '../server/tool-definition.ts';
import { previewTemplate } from '@shrkcrft/templates';
import { buildNameVariables } from '@shrkcrft/generator';

export const renderTemplatePreviewTool: IToolDefinition = {
  name: 'render_template_preview',
  description: 'Render a template preview (without writing). Returns target paths + contents.',
  inputSchema: {
    type: 'object',
    properties: {
      templateId: { type: 'string' },
      name: { type: 'string' },
      variables: { type: 'object', additionalProperties: { type: 'string' } },
    },
    required: ['templateId'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const t = ctx.inspection.templateRegistry.get(String(input.templateId));
    if (!t) return { isError: true, text: `No template with id "${input.templateId}"` };
    const nameVars = typeof input.name === 'string' ? buildNameVariables(input.name) : {};
    const values = { ...nameVars, ...((input.variables as Record<string, string> | undefined) ?? {}) };
    const preview = previewTemplate(t, values);
    if (!preview.validation.valid) {
      return {
        isError: true,
        data: { issues: preview.validation.issues },
        text: preview.validation.issues
          .map((i) => `${i.variable}: ${i.message}`)
          .join('\n'),
      };
    }
    return {
      data: {
        templateId: t.id,
        files: preview.rendered!.files,
        postGenerationNotes: preview.rendered!.postGenerationNotes,
      },
    };
  },
};
