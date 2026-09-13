/**
 * Read-only MCP tools for self-config doctor + graph.
 */
import { settleVerdict } from '@shrkcrft/core';
import {
  assetDoctorProposedExit,
  buildDeclaredXrefReport,
  buildSelfConfigDoctorReportV2,
  buildSelfConfigGraph,
  projectSelfConfigDoctorV2ToV1,
  withDeclaredXrefEdges,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

/**
 * ONE doctor: v1 is a projection of v2, so `schema` picks the SHAPE, never a
 * different set of checks. (The MCP tool used to run a separate v1 doctor that
 * disagreed with `shrk self-config doctor`.) Command strings stay NOT verified
 * here — the command index lives in the CLI — and the report says so in
 * `coverage` and one `command-probe-unverified` info finding.
 */
export const getSelfConfigDoctorTool: IToolDefinition = {
  name: 'get_self_config_doctor',
  description:
    'Run the self-config cross-reference doctor (the same checks as `shrk self-config doctor`). Validates that knowledge/templates/playbooks/agent-tests/search-tuning/routing & registration hints/scaffold patterns references resolve, and reports per-unit coverage (dead selectors, unverified units). Carries the settled verdict the CLI prints (without its flags): `exitCode`, `settledVerdict`, `shortfalls`, and `accepted` — every intended-empty (expectEmpty) unit it accepted. `schema`: "v1" (default, legacy shape) or "v2". Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      schema: {
        type: 'string',
        enum: ['v1', 'v2'],
        description: 'Report shape: "v1" (default, back-compat) or "v2" (findings with source/target kinds, probes, coverage).',
      },
    },
  },
  async handler(input, ctx) {
    const report = await buildSelfConfigDoctorReportV2(ctx.inspection);
    // THE asset-doctor proposal and THE settle the CLI uses (round 13), so an
    // expectEmpty acceptance reaches MCP as `accepted`, exactly as it is printed.
    const settled = settleVerdict(
      assetDoctorProposedExit(
        { errors: report.totals.error, warnings: report.totals.warning, units: report.selectorUnits },
        { strict: false, failOnDeadUnits: false },
      ),
      report.coverage,
    );
    const verdict = {
      exitCode: settled.exit,
      settledVerdict: settled.verdict,
      shortfalls: settled.shortfalls,
      accepted: settled.accepted,
    };
    if (input.schema === 'v2') return { data: { ...report, ...verdict } };
    return { data: { ...projectSelfConfigDoctorV2ToV1(report), ...verdict } };
  },
};

export const getSelfConfigGraphTool: IToolDefinition = {
  name: 'get_self_config_graph',
  description:
    'Return the self-config reference graph (nodes + edges + brokenEdges), including one edge per declared cross-reference id (knowledge related/seeAlso/supersededBy, construct/boundary/template related*) — dangling ones in brokenEdges. Read-only.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  async handler(_input, ctx) {
    // The same composition `shrk self-config graph|broken-links` prints.
    const graph = await buildSelfConfigGraph(ctx.inspection);
    return { data: withDeclaredXrefEdges(graph, await buildDeclaredXrefReport(ctx.inspection)) };
  },
};
