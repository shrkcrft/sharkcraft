import { buildSafetyAudit } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';
// DX#4 — derive the audit list at runtime from ALL_TOOLS instead of
// maintaining a parallel static list.
import { ALL_TOOLS } from './all-tools.ts';
import { COMMAND_CATALOG_EXPORT } from './command-catalog.tool.ts';

const PLAN_SECRET_ENV = 'SHARKCRAFT_PLAN_SECRET';

export const getSafetyAuditTool: IToolDefinition = {
  name: 'get_safety_audit',
  description:
    'Return the SharkCraft safety audit: command safety levels, MCP read-only invariant, pack signature status, verification command trust, plan-signing status, recommendations. READ-ONLY.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async handler(_input, ctx) {
    const planSecretConfigured =
      typeof process !== 'undefined' && process.env[PLAN_SECRET_ENV] !== undefined;
    // Translate the catalog into the audit-input shape (already aligned).
    const catalog = COMMAND_CATALOG_EXPORT.map((e) => ({
      command: e.command,
      description: e.description,
      category: e.category,
      safetyLevel: e.safetyLevel,
      writesFiles: e.writesFiles,
      writesSource: e.writesSource,
      runsShell: e.runsShell,
      requiresReview: e.requiresReview,
      mcpAvailable: e.mcpAvailable,
    }));
    const mcpTools = ALL_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
    }));
    const report = buildSafetyAudit({
      inspection: ctx.inspection,
      catalog,
      mcpTools,
      planSecretEnv: PLAN_SECRET_ENV,
      planSecretConfigured,
    });
    return { data: report };
  },
};
