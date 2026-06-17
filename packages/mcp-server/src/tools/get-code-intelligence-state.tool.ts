import {
  buildCodeIntelligenceChecks,
  DoctorSeverity,
  type IDoctorCheck,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';
import { FORMAT_INPUT_PROPERTY, formatObjectArrays } from '../server/columnar-format.ts';

interface IInput {
  /** Restrict to specific severities. Same set as `shrk code-intel --only`. */
  only?: ReadonlyArray<'ok' | 'info' | 'warning' | 'error'>;
  /** Restrict to a single check id. */
  checkId?: string;
}

/**
 * Read-only MCP mirror of `shrk code-intel`. Returns the same 14
 * code-intelligence doctor findings in one shot — agents can pull
 * the entire state without iterating `shrk doctor`'s full check list.
 *
 * Stable output schema (`sharkcraft.code-intelligence-state/v1`) so
 * downstream renderers (dashboard, CI bots) can rely on the shape.
 */
export const getCodeIntelligenceStateTool: IToolDefinition = {
  name: 'get_code_intelligence_state',
  description:
    'Return all code-intelligence doctor findings (graph, rule-graph, api-surface, quality-gate, migrations, architecture, impact, framework, structural-search, context-planner) in one payload. Read-only.',
  cliCommand: 'code-intel',
  inputSchema: {
    type: 'object',
    properties: {
      only: { type: 'array', items: { type: 'string' } },
      checkId: { type: 'string' },
      ...FORMAT_INPUT_PROPERTY,
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const args = input as IInput;
    let checks = buildCodeIntelligenceChecks(ctx.inspection.projectRoot);
    if (args.checkId) {
      checks = checks.filter((c) => c.id === args.checkId);
    }
    if (args.only && args.only.length > 0) {
      const allowed = new Set(args.only.map((s) => s.toLowerCase()));
      checks = checks.filter((c) => allowed.has(c.severity));
    }
    const summary = summarize(checks);
    const data = {
      schema: 'sharkcraft.code-intelligence-state/v1',
      totalChecks: checks.length,
      summary,
      checks,
    };
    return { data: formatObjectArrays(data, input) };
  },
};

function summarize(checks: readonly IDoctorCheck[]) {
  let ok = 0;
  let info = 0;
  let warnings = 0;
  let errors = 0;
  for (const c of checks) {
    if (c.severity === DoctorSeverity.Ok) ok += 1;
    else if (c.severity === DoctorSeverity.Info) info += 1;
    else if (c.severity === DoctorSeverity.Warning) warnings += 1;
    else if (c.severity === DoctorSeverity.Error) errors += 1;
  }
  return { ok, info, warnings, errors };
}
