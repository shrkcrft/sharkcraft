import { AGENT_INSTRUCTIONS } from '@shrkcrft/inspector';
export const getAgentInstructionsTool = {
    name: 'get_agent_instructions',
    description: 'Returns compact instructions for AI agents on how to use this repository through SharkCraft.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
        return { text: AGENT_INSTRUCTIONS, data: { instructions: AGENT_INSTRUCTIONS } };
    },
};
