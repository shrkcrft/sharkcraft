import * as nodePath from 'node:path';
import { auditCiWorkflow, type CiProviderForAudit } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

const VALID = new Set<CiProviderForAudit>(['github-actions', 'gitlab', 'bitbucket', 'azure', 'jenkins']);

export const getCiPermissionsAuditTool: IToolDefinition = {
  name: 'get_ci_permissions_audit',
  description:
    'Audit a CI workflow YAML for write permissions, comment posting, tokens, external actions. Read-only.',
  inputSchema: {
    type: 'object',
    required: ['file'],
    properties: {
      file: { type: 'string' },
      provider: { type: 'string', enum: ['github-actions', 'gitlab', 'bitbucket', 'azure', 'jenkins'] },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const fileRaw = typeof input['file'] === 'string' ? (input['file'] as string) : '';
    const providerRaw = typeof input['provider'] === 'string' ? (input['provider'] as CiProviderForAudit) : null;
    const abs = nodePath.isAbsolute(fileRaw) ? fileRaw : nodePath.resolve(ctx.cwd, fileRaw);
    const audit = auditCiWorkflow({
      file: abs,
      provider: providerRaw && VALID.has(providerRaw) ? providerRaw : null,
    });
    return { data: audit };
  },
};
