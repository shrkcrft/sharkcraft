import { RuleGraphQueryApi } from '@shrkcrft/rule-graph';
import type { IToolDefinition } from '../server/tool-definition.ts';

interface IInput {
  file?: string;
}

export const getRulesForFileTool: IToolDefinition = {
  name: 'get_rules_for_file',
  description:
    'Read-only bridge query: return rules (boundary), path conventions, and templates that apply to the given file. Requires `shrk graph index` + `shrk rule-graph index`.',
  cliCommand: 'rule-graph for',
  inputSchema: {
    type: 'object',
    properties: { file: { type: 'string' } },
    required: ['file'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const file = ((input as IInput).file ?? '').trim();
    if (!file) {
      return {
        isError: true,
        error: { code: 'invalid-input', message: 'file is required' },
      };
    }
    const missing = RuleGraphQueryApi.missingDescription(ctx.inspection.projectRoot);
    if (missing) {
      const next = missing.includes('rule-graph') ? 'shrk rule-graph index' : 'shrk graph index';
      return {
        isError: true,
        error: {
          code: 'bridge-missing',
          message: missing,
          details: { nextCommand: next },
        },
      };
    }
    const api = RuleGraphQueryApi.fromStores(ctx.inspection.projectRoot);
    const r = api.forFile(file);
    if (!r) {
      return {
        isError: true,
        error: { code: 'not-found', message: `No file node for "${file}".`, details: { file } },
      };
    }
    return {
      data: {
        schema: 'sharkcraft.rule-graph-for-file/v1',
        file: r.path,
        rules: r.rules.map((h) => ({
          id: h.target.id,
          label: h.target.label,
          severity: (h.edge.data?.['severity'] as string | undefined) ?? undefined,
        })),
        paths: r.paths.map((h) => ({ id: h.target.id, label: h.target.label })),
        templates: r.templates.map((h) => ({ id: h.target.id, label: h.target.label })),
      },
    };
  },
};
