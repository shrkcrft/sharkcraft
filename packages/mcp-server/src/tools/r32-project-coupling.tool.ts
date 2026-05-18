/**
 * Read-only project-specific coupling audit.
 */
import { auditProjectCoupling } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getProjectCouplingReportTool: IToolDefinition = {
  name: 'get_project_coupling_report',
  description:
    'Scan the workspace for project-specific tokens (caller-supplied identifiers like legacy library paths or key-table names) and report each occurrence with a recommended externalization target. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['tokens'],
    properties: {
      tokens: { type: 'array' },
      scanRoots: { type: 'array' },
      excludeRoots: { type: 'array' },
    },
  },
  async handler(input, ctx) {
    const raw = input.tokens;
    const tokens: string[] = Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string') : [];
    if (tokens.length === 0) {
      return { isError: true, error: { code: 'invalid-input', message: 'tokens must be a non-empty array of strings.' } };
    }
    const scanRoots = Array.isArray(input.scanRoots)
      ? (input.scanRoots.filter((r): r is string => typeof r === 'string') as string[])
      : undefined;
    const excludeRoots = Array.isArray(input.excludeRoots)
      ? (input.excludeRoots.filter((r): r is string => typeof r === 'string') as string[])
      : undefined;
    const report = auditProjectCoupling({
      projectRoot: ctx.cwd,
      tokens,
      ...(scanRoots ? { scanRoots } : {}),
      ...(excludeRoots ? { excludeRoots } : {}),
    });
    return { data: report };
  },
};
