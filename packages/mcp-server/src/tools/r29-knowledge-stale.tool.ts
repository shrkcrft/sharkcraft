/**
 * Read-only MCP tools for knowledge stale-check / references.
 *
 *   get_knowledge_stale_report  — run the stale-check across all entries.
 *   get_knowledge_references    — list references + anchors for one entry.
 */
import {
  buildKnowledgeStaleReport,
  describeInspectionDiscovery,
  warmReferenceRegistries,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

function nextHint(cmd: string): string {
  return `Next: \`${cmd}\` (CLI is the only write path).`;
}

export const getKnowledgeStaleReportTool: IToolDefinition = {
  name: 'get_knowledge_stale_report',
  description:
    'Validate `references[]` + `anchors[]` on each knowledge entry — three buckets (verified / stale / unverifiable), per-kind counts and where discovery landed. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      changedFiles: {
        type: 'array',
        items: { type: 'string' },
        description: 'When supplied, restricts checks to entries that touch one of these files.',
      },
    },
  },
  async handler(input, ctx) {
    const changed = Array.isArray(input.changedFiles)
      ? (input.changedFiles as string[])
      : undefined;
    // Warm before resolving: the playbook / policy / construct / helper
    // registries are async-filled, and unwarmed they would make a correct id
    // unverifiable. (No command index here — `command` references stay NOT
    // VERIFIED; the CLI verb injects it.)
    await warmReferenceRegistries(ctx.inspection);
    const report = buildKnowledgeStaleReport(ctx.inspection, {
      ...(changed ? { changedFiles: changed } : {}),
    });
    const c = report.coverage;
    const pct = c.entriesInScope > 0 ? Math.round((c.unverifiable / c.entriesInScope) * 1000) / 10 : 0;
    return {
      text:
        `entries in scope: ${c.entriesInScope} · verified: ${c.verified} · stale: ${c.stale} · unverifiable: ${c.unverifiable} (${pct}%)\n` +
        nextHint('shrk knowledge stale-check'),
      data: { ...report, discovery: describeInspectionDiscovery(ctx.inspection) },
    };
  },
};

export const getKnowledgeReferencesTool: IToolDefinition = {
  name: 'get_knowledge_references',
  description:
    'Return references + anchors for one knowledge entry. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: { type: 'string' },
    },
  },
  async handler(input, ctx) {
    const id = typeof input.id === 'string' ? input.id : '';
    const entry = ctx.inspection.index.get(id);
    if (!entry) {
      return {
        text: `Knowledge entry not found: ${id}`,
        data: null,
      };
    }
    return {
      text: nextHint(`shrk knowledge references ${id}`),
      data: {
        id: entry.id,
        title: entry.title,
        references: entry.references ?? [],
        anchors: entry.anchors ?? [],
      },
    };
  },
};
