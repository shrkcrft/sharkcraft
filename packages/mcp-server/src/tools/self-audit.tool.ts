import { buildSelfAudit, detectSharkcraftRepo, buildReleaseReadiness, buildDocsCheck, buildExamplesCheck } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getSelfAuditTool: IToolDefinition = {
  name: 'get_self_audit',
  description:
    'Run the SharkCraft self-dogfood audit. Returns a single verdict aggregating release readiness, docs/examples checks, and MCP safety. Read-only.',
  inputSchema: { type: 'object', additionalProperties: false },
  async handler(_input, ctx) {
    const isRepo = detectSharkcraftRepo(ctx.cwd);
    if (!isRepo) {
      return { data: buildSelfAudit(ctx.cwd) };
    }
    const readiness = await buildReleaseReadiness(ctx.inspection, {
      includeDocsCheck: true,
      includeExamplesCheck: true,
    });
    const docs = buildDocsCheck(ctx.cwd);
    const examples = buildExamplesCheck(ctx.cwd);
    return {
      data: buildSelfAudit(ctx.cwd, {
        releaseReadinessReady: readiness.ready,
        releaseReadinessBlockers: readiness.blockers.length,
        releaseReadinessWarnings: readiness.warnings.length,
        mcpAuditWriteToolCount: 0,
        docsCheckOk: docs.ok,
        examplesCheckOk: examples.ok,
      }),
    };
  },
};
