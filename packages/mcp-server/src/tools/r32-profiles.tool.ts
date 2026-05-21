/**
 * Read-only MCP tools for profiles.
 *
 * Engine never writes from MCP. These tools surface pack-contributed and
 * locally configured profiles so an agent can decide which one to pass to
 * a profile-aware command (the human runs the CLI).
 */
import {
  findProfile,
  listProfileIssues,
  listProfiles,
  ProfileKind,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const listProfilesTool: IToolDefinition = {
  name: 'list_profiles',
  description: 'List all pack-contributed and locally configured profiles. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { kind: { type: 'string' } },
  },
  async handler(input, ctx) {
    const kindArg = typeof input.kind === 'string' ? (input.kind as string) : undefined;
    const kind = kindArg && (Object.values(ProfileKind) as readonly string[]).includes(kindArg)
      ? (kindArg as ProfileKind)
      : undefined;
    return { data: await listProfiles(ctx.inspection, kind ? { kind } : {}) };
  },
};

export const getProfileTool: IToolDefinition = {
  name: 'get_profile',
  description: 'Get one profile by id (and optional kind). Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'string' }, kind: { type: 'string' } },
  },
  async handler(input, ctx) {
    const id = typeof input.id === 'string' ? (input.id as string) : '';
    if (!id) return { isError: true, error: { code: 'invalid-input', message: 'id is required.' } };
    const kindArg = typeof input.kind === 'string' ? (input.kind as string) : undefined;
    const kind = kindArg && (Object.values(ProfileKind) as readonly string[]).includes(kindArg)
      ? (kindArg as ProfileKind)
      : undefined;
    const entry = await findProfile(ctx.inspection, id, kind);
    if (!entry) {
      return { isError: true, error: { code: 'not-found', message: `Unknown profile id "${id}"${kind ? ` (kind=${kind})` : ''}.` } };
    }
    return { data: entry };
  },
};

export const getProfilesDoctorTool: IToolDefinition = {
  name: 'get_profiles_doctor',
  description: 'Profile registry doctor — surface load issues across all profile kinds. Read-only.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  async handler(_input, ctx) {
    return { data: { issues: await listProfileIssues(ctx.inspection) } };
  },
};

