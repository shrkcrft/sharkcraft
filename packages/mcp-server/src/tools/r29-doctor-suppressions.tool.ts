/**
 * Read-only MCP tools for doctor suppressions.
 *
 *   get_doctor_suppressions     — list the configured suppression entries.
 *   get_doctor_filtered_report  — run the doctor + filter through the
 *                                 suppression set; show what stays visible
 *                                 vs. what's hidden.
 */
import {
  filterDoctorResult,
  loadDoctorSuppressions,
  runDoctor,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

function nextHint(cmd: string): string {
  return `Next: \`${cmd}\` (CLI is the only write path).`;
}

export const getDoctorSuppressionsTool: IToolDefinition = {
  name: 'get_doctor_suppressions',
  description:
    'Return the contents of sharkcraft/doctor.suppressions.json. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {},
  },
  async handler(_input, ctx) {
    const cfg = loadDoctorSuppressions(ctx.cwd);
    return {
      text: nextHint('shrk doctor suppressions list'),
      data: cfg,
    };
  },
};

export const getDoctorFilteredReportTool: IToolDefinition = {
  name: 'get_doctor_filtered_report',
  description:
    'Run shrk doctor and apply the configured suppressions (+ optional focus / hide). Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      focus: {
        type: 'array',
        items: { type: 'string' },
        description: 'Subset of: errors, warnings, warnings-new, info, ok, all.',
      },
      hide: {
        type: 'array',
        items: { type: 'string' },
        description: 'Category names to hide (e.g. action-hint-quality).',
      },
      quietKnown: { type: 'boolean' },
    },
  },
  async handler(input, ctx) {
    const result = runDoctor(ctx.inspection);
    const cfg = loadDoctorSuppressions(ctx.cwd);
    const focus = Array.isArray(input.focus) ? (input.focus as string[]) : undefined;
    const hide = Array.isArray(input.hide) ? (input.hide as string[]) : undefined;
    const quietKnown = input.quietKnown === true;
    const filtered = filterDoctorResult(result, {
      suppressions: cfg.doctorSuppressions,
      ...(focus ? { focus: focus as ['errors'] } : {}),
      ...(hide ? { hide } : {}),
      ...(quietKnown ? { quietKnown } : {}),
    });
    return {
      text: nextHint('shrk doctor --quiet-known'),
      data: filtered,
    };
  },
};
