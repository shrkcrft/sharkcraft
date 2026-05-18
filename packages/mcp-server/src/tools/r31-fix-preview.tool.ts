/**
 * Read-only MCP tools for the fix-preview system.
 *
 * `preview_fix` — return structured fix suggestions for a kind subset.
 * `list_fix_kinds` — return the supported fix kinds.
 *
 * Read-only. No source mutations. The CLI is the only path that writes
 * previews (and only under `.sharkcraft/fixes/`).
 */
import { buildFixPreview, FixKind, listFixKinds } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const previewFixTool: IToolDefinition = {
  name: 'preview_fix',
  description:
    'Return fix-preview suggestions for action hints / stale knowledge / template drift. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      kinds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Subset of fix kinds (action-hints, knowledge-stale, template-drift).',
      },
      target: { type: 'string', description: 'Optional target id filter.' },
    },
  },
  async handler(input, ctx) {
    const kindsRaw = Array.isArray(input.kinds) ? (input.kinds as string[]) : [];
    const kinds: FixKind[] = [];
    for (const k of kindsRaw) {
      if (k === 'action-hints') kinds.push(FixKind.ActionHints);
      if (k === 'knowledge-stale') kinds.push(FixKind.KnowledgeStale);
      if (k === 'template-drift') kinds.push(FixKind.TemplateDrift);
    }
    const report = buildFixPreview(ctx.inspection, kinds.length > 0 ? { kinds } : {});
    const target = typeof input.target === 'string' ? input.target : undefined;
    const suggestions = target
      ? report.suggestions.filter((s) => s.targetId === target)
      : report.suggestions;
    return {
      text: 'Next: `shrk fix preview` (preview-only). To write, add `--write-preview` (writes only under .sharkcraft/fixes).',
      data: { ...report, suggestions },
    };
  },
};

export const listFixKindsTool: IToolDefinition = {
  name: 'list_fix_kinds',
  description: 'List supported fix kinds for `shrk fix preview` (read-only).',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  async handler() {
    return {
      text: 'Next: `shrk fix list`',
      data: { schema: 'sharkcraft.fix-kinds/v1', kinds: listFixKinds() },
    };
  },
};
