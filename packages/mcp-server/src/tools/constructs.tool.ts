import { loadConstructs, traceConstruct } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const listConstructsTool: IToolDefinition = {
  name: 'list_constructs',
  description: 'List registered constructs. Read-only.',
  inputSchema: { type: 'object', properties: { type: { type: 'string' } } },
  async handler(input, ctx) {
    const type = typeof input['type'] === 'string' ? (input['type'] as string) : undefined;
    const list = await loadConstructs(ctx.inspection);
    return { data: type ? list.filter((c) => c.type === type) : list };
  },
};

export const getConstructTool: IToolDefinition = {
  name: 'get_construct',
  description: 'Show details for a single construct. Read-only.',
  inputSchema: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' } },
  },
  async handler(input, ctx) {
    const id = String(input['id'] ?? '');
    const list = await loadConstructs(ctx.inspection);
    const c = list.find((x) => x.id === id);
    if (!c) return { error: { code: 'not-found', message: `No construct "${id}"` } };
    return { data: c };
  },
};

export const traceConstructTool: IToolDefinition = {
  name: 'trace_construct',
  description: 'Trace files / publicApi / events / tokens of a construct. Read-only.',
  inputSchema: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' } },
  },
  async handler(input, ctx) {
    const id = String(input['id'] ?? '');
    const list = await loadConstructs(ctx.inspection);
    const c = list.find((x) => x.id === id);
    if (!c) return { error: { code: 'not-found', message: `No construct "${id}"` } };
    return { data: traceConstruct(c) };
  },
};

export const getConstructApiTool: IToolDefinition = {
  name: 'get_construct_api',
  description: 'Return the publicApi entries for a construct. Read-only.',
  inputSchema: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' } },
  },
  async handler(input, ctx) {
    const id = String(input['id'] ?? '');
    const list = await loadConstructs(ctx.inspection);
    const c = list.find((x) => x.id === id);
    if (!c) return { error: { code: 'not-found', message: `No construct "${id}"` } };
    return { data: { id, publicApi: c.publicApi ?? [] } };
  },
};

export const listConstructFacetsTool: IToolDefinition = {
  name: 'list_construct_facets',
  description: 'List facets of a construct. Read-only.',
  inputSchema: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' } },
  },
  async handler(input, ctx) {
    const id = String(input['id'] ?? '');
    const list = await loadConstructs(ctx.inspection);
    const c = list.find((x) => x.id === id);
    if (!c) return { error: { code: 'not-found', message: `No construct "${id}"` } };
    return { data: { id, facets: c.facets ?? {} } };
  },
};
