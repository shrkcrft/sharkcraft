import {
  buildDiagnosticByCode,
  getDiagnosticEntry,
  listDiagnostics,
  type FailureDiagnosticCode,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getDiagnosticForCodeTool: IToolDefinition = {
  name: 'get_diagnostic_for_code',
  description:
    'Look up a structured SharkCraft failure diagnostic by code. Provide optional context for the placeholders. Returns problem / likelyCause / nextCommand / docsLink. Read-only.',
  inputSchema: {
    type: 'object',
    required: ['code'],
    properties: {
      code: { type: 'string' },
      context: { type: 'object' },
    },
    additionalProperties: false,
  },
  handler(input) {
    const code = String(input['code'] ?? '');
    const entry = getDiagnosticEntry(code);
    if (!entry) {
      return {
        isError: true,
        error: {
          code: 'unknown-diagnostic',
          message: `Unknown diagnostic code "${code}".`,
          details: { known: listDiagnostics().map((e) => e.code) },
        },
        data: { schema: 'sharkcraft.diagnostic-registry/v1', known: listDiagnostics() },
      };
    }
    const ctx = (input['context'] as Record<string, unknown>) ?? {};
    const diagnostic = buildDiagnosticByCode(entry.code as FailureDiagnosticCode, ctx);
    return { data: diagnostic };
  },
};

export const listDiagnosticsTool: IToolDefinition = {
  name: 'list_diagnostics',
  description: 'List every known SharkCraft failure diagnostic. Read-only.',
  inputSchema: { type: 'object', additionalProperties: false },
  handler() {
    return { data: { schema: 'sharkcraft.diagnostic-registry/v1', entries: listDiagnostics() } };
  },
};
