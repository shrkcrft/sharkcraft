import { generate } from '@shrkcrft/generator';
export const createGenerationPlanTool = {
    name: 'create_generation_plan',
    description: 'Create a generation plan (dry-run). Never writes files. Use to preview a template before applying.',
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
        const templateId = String(input.templateId);
        const template = ctx.inspection.templateRegistry.get(templateId);
        if (!template)
            return { isError: true, text: `No template with id "${templateId}"` };
        const variables = input.variables ?? {};
        const result = generate(template, {
            templateId,
            name: typeof input.name === 'string' ? input.name : undefined,
            variables,
            projectRoot: ctx.inspection.projectRoot,
            write: false,
        });
        if (!result.ok)
            return { isError: true, text: result.error.message };
        const { plan } = result.value;
        return {
            data: {
                templateId: plan.templateId,
                templateName: plan.templateName,
                totalFiles: plan.totalFiles,
                hasConflicts: plan.hasConflicts,
                warnings: plan.warnings,
                postGenerationNotes: plan.postGenerationNotes,
                changes: plan.changes.map((c) => ({
                    type: c.type,
                    relativePath: c.relativePath,
                    sizeBytes: c.sizeBytes,
                    reason: c.reason,
                })),
            },
        };
    },
};
