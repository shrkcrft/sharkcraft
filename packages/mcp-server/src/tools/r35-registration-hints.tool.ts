/**
 * Read-only MCP tools for registration hints.
 *
 *   list_registration_hints     — enumerate registered hints (filter by source).
 *   get_registration_hint       — fetch a hint by id.
 *   preview_registration_hint   — render a preview against the live file system.
 *
 * All tools are strictly read-only.
 */
import {
  listRegistrationHints,
  getRegistrationHint,
  previewRegistrationHint,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const listRegistrationHintsTool: IToolDefinition = {
  name: 'list_registration_hints',
  description: 'List pack/local registration hints. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { source: { type: 'string' } },
  },
  async handler(input, ctx) {
    let entries = await listRegistrationHints(ctx.inspection);
    if (typeof input.source === 'string') entries = entries.filter((e) => e.source === input.source);
    return { data: entries };
  },
};

export const getRegistrationHintTool: IToolDefinition = {
  name: 'get_registration_hint',
  description: 'Fetch a registration hint by id. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'string' } },
  },
  async handler(input, ctx) {
    const id = typeof input.id === 'string' ? (input.id as string) : '';
    if (!id) return { isError: true, error: { code: 'invalid-input', message: 'id required' } };
    const entry = await getRegistrationHint(ctx.inspection, id);
    if (!entry) return { isError: true, error: { code: 'not-found', message: `Unknown hint "${id}".` } };
    return { data: entry };
  },
};

export const previewRegistrationHintTool: IToolDefinition = {
  name: 'preview_registration_hint',
  description:
    'Preview a registration hint against the live file system. Read-only — no edits are made; ambiguous discovery is reported, not guessed.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: { type: 'string' },
      variables: { type: 'object', additionalProperties: { type: 'string' } },
    },
  },
  async handler(input, ctx) {
    const id = typeof input.id === 'string' ? (input.id as string) : '';
    if (!id) return { isError: true, error: { code: 'invalid-input', message: 'id required' } };
    const variables =
      input.variables && typeof input.variables === 'object'
        ? (input.variables as Readonly<Record<string, string>>)
        : {};
    const preview = await previewRegistrationHint(ctx.inspection, id, { variables });
    if (!preview) return { isError: true, error: { code: 'not-found', message: `Unknown hint "${id}".` } };
    return { data: preview };
  },
};
