import * as nodePath from 'node:path';
import { auditCiWorkflow, buildCiPermissionsFixPreview, type CiProviderForAudit } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getCiPermissionsFixPreviewTool: IToolDefinition = {
  name: 'get_ci_permissions_fix_preview',
  description: 'Suggest a least-privilege fix for a CI workflow. Read-only — never writes.',
  inputSchema: {
    type: 'object',
    required: ['file'],
    properties: {
      file: { type: 'string' },
      provider: {
        type: 'string',
        enum: ['github-actions', 'gitlab', 'bitbucket', 'azure', 'jenkins'],
      },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const fileRaw = typeof input['file'] === 'string' ? (input['file'] as string) : '';
    if (!fileRaw) {
      return {
        isError: true,
        error: { code: 'invalid-input', message: 'Missing `file`.' },
      };
    }
    const file = nodePath.isAbsolute(fileRaw) ? fileRaw : nodePath.resolve(ctx.cwd, fileRaw);
    const providerRaw = typeof input['provider'] === 'string' ? (input['provider'] as CiProviderForAudit) : null;
    const audit = auditCiWorkflow({ file, provider: providerRaw });
    const preview = buildCiPermissionsFixPreview(audit);
    return { data: preview };
  },
};
