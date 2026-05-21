/**
 * Repository intelligence MCP tools. All read-only.
 */
import {
  buildArchitectureArea,
  buildArchitectureViolations,
  buildProductCoherenceReport,
  buildRepositoryIntelligenceGraph,
  computeRiskSignals,
  parseRepositoryGraphExpression,
  previewComplianceEvidencePacket,
  queryRepositoryIntelligence,
  readPolicyOverrideAudit,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const queryRepositoryIntelligenceTool: IToolDefinition = {
  name: 'query_repository_intelligence',
  description:
    'Filter the repository intelligence graph by kind/edge/imports/depends-on/text/tag/package/construct. DSL: AND (space, default), OR (literal), not:<filter>. Opt-in alias-resolved imports.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      includeImports: { type: 'boolean' },
      resolveAliases: { type: 'boolean' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const raw = typeof input['query'] === 'string' ? (input['query'] as string) : '';
    const resolveAliases = input['resolveAliases'] === true;
    const includeImports =
      input['includeImports'] === true || resolveAliases || /imports:|depends-on:/i.test(raw);
    const graph = await buildRepositoryIntelligenceGraph(ctx.inspection, { includeImports, resolveAliases });
    const { expression, errors } = parseRepositoryGraphExpression(raw);
    const r = queryRepositoryIntelligence(graph, expression);
    return {
      data: {
        expression,
        errors,
        nodeCount: r.nodes.length,
        edgeCount: r.edges.length,
        reasons: r.reasons,
        nodes: r.nodes.slice(0, 100),
        edges: r.edges.slice(0, 100),
      },
    };
  },
};

export const getArchitectureViolationsTool: IToolDefinition = {
  name: 'get_architecture_violations',
  description: 'Boundary violations report (read-only).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    return { data: await buildArchitectureViolations(ctx.inspection) };
  },
};

export const getArchitectureAreaTool: IToolDefinition = {
  name: 'get_architecture_area',
  description: 'Members of an architecture area (layer id).',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const id = typeof input['id'] === 'string' ? (input['id'] as string) : '';
    return { data: await buildArchitectureArea(ctx.inspection, id) };
  },
};

export const getRiskSignalsTool: IToolDefinition = {
  name: 'get_risk_signals',
  description: 'Compute deterministic risk signals (boundary violations, architecture risks, pack signatures, tests).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    return { data: await computeRiskSignals(ctx.inspection) };
  },
};

export const previewComplianceEvidencePacketTool: IToolDefinition = {
  name: 'preview_compliance_evidence_packet',
  description: 'Preview what `shrk compliance evidence <profileId>` would write (read-only, does NOT write).',
  inputSchema: {
    type: 'object',
    properties: { profileId: { type: 'string' } },
    required: ['profileId'],
    additionalProperties: false,
  },
  async handler(input) {
    const profileId = typeof input['profileId'] === 'string' ? (input['profileId'] as string) : '';
    return { data: previewComplianceEvidencePacket(profileId) };
  },
};

export const getPolicyOverrideAuditTool: IToolDefinition = {
  name: 'get_policy_override_audit',
  description: 'Read the policy override audit trail (read-only).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    return { data: { schema: 'sharkcraft.policy-override-audit/v1', entries: readPolicyOverrideAudit(ctx.inspection) } };
  },
};

export const getCommandTaxonomyTool: IToolDefinition = {
  name: 'get_command_taxonomy',
  description: 'Command taxonomy report (read-only).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler() {
    // The CLI carries the canonical catalog; here we describe the surface
    // without importing it (no inspector → CLI dependency). Consumers can
    // run `shrk commands taxonomy` for the full grouped output.
    return {
      data: {
        note: 'Run `shrk commands taxonomy --json` for the live grouped output.',
        groups: [
          'start-here', 'daily-development', 'ai-agent-context', 'review-impact',
          'architecture', 'governance-compliance', 'packs', 'ci-reports',
          'release-readiness', 'diagnostics', 'advanced',
        ],
      },
    };
  },
};

export const getProductCoherenceTool: IToolDefinition = {
  name: 'get_product_coherence',
  description: 'Verify the SharkCraft product narrative is coherent.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    return { data: buildProductCoherenceReport(ctx.inspection) };
  },
};
