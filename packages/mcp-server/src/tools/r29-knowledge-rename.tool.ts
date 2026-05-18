/**
 * Read-only MCP tool: preview_knowledge_rename.
 */
import {
  buildAnchorUpdatePlan,
  buildRenameFilePlan,
  buildRenameSymbolPlan,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

function nextHint(cmd: string): string {
  return `Next: \`${cmd}\` (CLI is the only write path).`;
}

export const previewKnowledgeRenameTool: IToolDefinition = {
  name: 'preview_knowledge_rename',
  description:
    'Preview a knowledge rename. Subcommands: `rename-symbol`, `rename-file`, `update-anchor`. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['kind'],
    properties: {
      kind: { type: 'string', enum: ['rename-symbol', 'rename-file', 'update-anchor'] },
      from: { type: 'string' },
      to: { type: 'string' },
      anchorId: { type: 'string' },
      toSymbol: { type: 'string' },
      toPath: { type: 'string' },
      toTargetId: { type: 'string' },
    },
  },
  async handler(input, ctx) {
    const kind = String(input.kind ?? '');
    if (kind === 'rename-symbol') {
      const from = String(input.from ?? '');
      const to = String(input.to ?? '');
      const plan = buildRenameSymbolPlan(ctx.inspection, { from, to });
      return { text: nextHint(`shrk knowledge rename-symbol ${from} ${to}`), data: plan };
    }
    if (kind === 'rename-file') {
      const from = String(input.from ?? '');
      const to = String(input.to ?? '');
      const plan = buildRenameFilePlan(ctx.inspection, { from, to });
      return { text: nextHint(`shrk knowledge rename-file ${from} ${to}`), data: plan };
    }
    if (kind === 'update-anchor') {
      const anchorId = String(input.anchorId ?? '');
      const plan = buildAnchorUpdatePlan(ctx.inspection, {
        anchorId,
        ...(typeof input.toSymbol === 'string' ? { toSymbol: input.toSymbol } : {}),
        ...(typeof input.toPath === 'string' ? { toPath: input.toPath } : {}),
        ...(typeof input.toTargetId === 'string' ? { toTargetId: input.toTargetId } : {}),
      });
      return { text: nextHint(`shrk knowledge update-anchor ${anchorId}`), data: plan };
    }
    return { text: `Unknown kind: ${kind}`, data: null };
  },
};
