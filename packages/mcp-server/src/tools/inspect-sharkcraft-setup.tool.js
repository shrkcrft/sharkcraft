import { runDoctor } from '@shrkcrft/inspector';
export const inspectSharkcraftSetupTool = {
    name: 'inspect_sharkcraft_setup',
    description: 'Validate the SharkCraft setup in the current repo (config, knowledge, templates).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler(_input, ctx) {
        const result = runDoctor(ctx.inspection);
        return { data: result };
    },
};
