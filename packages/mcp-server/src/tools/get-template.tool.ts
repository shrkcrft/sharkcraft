import { templateRemainderFields, templateRemainderLines } from '@shrkcrft/templates';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getTemplateTool: IToolDefinition = {
  name: 'get_template',
  description:
    'Get one template by id, including variables, notes and its declared remainder (notScaffolded / manualSteps — what it deliberately does NOT do).',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const id = String(input.id ?? '');
    const t = ctx.inspection.templateRegistry.get(id);
    if (!t) return { isError: true, text: `No template with id "${id}"` };
    return {
      data: {
        id: t.id,
        name: t.name,
        description: t.description,
        tags: t.tags,
        scope: t.scope,
        appliesWhen: t.appliesWhen,
        variables: t.variables,
        postGenerationNotes: t.postGenerationNotes ?? [],
        // The remainder `templates get --json` carries — the one shape
        // (`templateRemainderFields`) plus the one printable wording.
        ...templateRemainderFields(t),
        remainderLines: templateRemainderLines(t),
        related: t.related ?? [],
      },
    };
  },
};
