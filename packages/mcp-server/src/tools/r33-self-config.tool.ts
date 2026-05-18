/**
 * Read-only MCP tools for self-config doctor + graph.
 */
import {
  buildSelfConfigDoctorReport,
  buildSelfConfigGraph,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getSelfConfigDoctorTool: IToolDefinition = {
  name: 'get_self_config_doctor',
  description:
    'Run the self-config cross-reference doctor. Validates that knowledge/templates/playbooks/agent-tests/search-tuning/etc. references resolve. Read-only.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  async handler(_input, ctx) {
    return { data: await buildSelfConfigDoctorReport(ctx.inspection) };
  },
};

export const getSelfConfigGraphTool: IToolDefinition = {
  name: 'get_self_config_graph',
  description: 'Return the self-config reference graph (nodes + edges + brokenEdges). Read-only.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  async handler(_input, ctx) {
    return { data: await buildSelfConfigGraph(ctx.inspection) };
  },
};
