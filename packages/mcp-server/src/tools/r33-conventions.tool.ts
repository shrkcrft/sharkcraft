/**
 * Read-only MCP tools for the convention registry.
 */
import {
  findConvention,
  listConventions,
  listConventionIssues,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const listConventionsTool: IToolDefinition = {
  name: 'list_conventions',
  description: 'List registered conventions (naming / path / barrel / layout / …). Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { kind: { type: 'string' }, source: { type: 'string' } },
  },
  async handler(input, ctx) {
    let entries = await listConventions(ctx.inspection);
    if (typeof input.kind === 'string') entries = entries.filter((e) => e.convention.kind === input.kind);
    if (typeof input.source === 'string') entries = entries.filter((e) => e.source === input.source);
    return { data: entries };
  },
};

export const getConventionTool: IToolDefinition = {
  name: 'get_convention',
  description: 'Get one convention by id. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'string' } },
  },
  async handler(input, ctx) {
    const id = typeof input.id === 'string' ? (input.id as string) : '';
    if (!id) return { isError: true, error: { code: 'invalid-input', message: 'id is required.' } };
    const entry = await findConvention(ctx.inspection, id);
    if (!entry) return { isError: true, error: { code: 'not-found', message: `Unknown convention "${id}".` } };
    return { data: entry };
  },
};

export const getConventionsDoctorTool: IToolDefinition = {
  name: 'get_conventions_doctor',
  description: 'Convention registry doctor — surface load/validation issues. Read-only.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  async handler(_input, ctx) {
    return { data: { issues: await listConventionIssues(ctx.inspection) } };
  },
};
