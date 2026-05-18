/**
 * Read-only MCP tool: preview_feedback_actions.
 */
import { ingestFeedbackText } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

function nextHint(cmd: string): string {
  return `Next: \`${cmd}\` (CLI is the only write path).`;
}

export const previewFeedbackActionsTool: IToolDefinition = {
  name: 'preview_feedback_actions',
  description:
    'Ingest feedback text (markdown) and return structured findings + follow-up commands. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: {
      text: { type: 'string' },
      sourceFile: { type: 'string' },
    },
  },
  async handler(input) {
    const text = String(input.text ?? '');
    const sourceFile = typeof input.sourceFile === 'string' ? input.sourceFile : undefined;
    const report = ingestFeedbackText(text, sourceFile);
    return { text: nextHint('shrk feedback ingest <file>'), data: report };
  },
};
