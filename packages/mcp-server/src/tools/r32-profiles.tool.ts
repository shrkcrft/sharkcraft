/**
 * Read-only MCP tools for profiles.
 *
 * Engine never writes from MCP. These tools surface the builtin `workspace`
 * profile vocabulary (WorkspaceProfile ids, with this repo's detection) and
 * pack-contributed / locally configured `migration` profiles, so an agent can
 * decide which one to pass to a profile-aware command (the human runs the CLI).
 *
 * `kind` is a closed enum, validated in TWO places (the advertised inputSchema
 * and the strict zod validator in tool-input-validators.ts). An unknown kind
 * used to be dropped silently, listing every kind; the handler still refuses
 * one for a direct (validator-bypassing) call.
 */
import {
  findProfile,
  isProfileKind,
  listProfileIssues,
  listProfiles,
  ProfileKind,
} from '@shrkcrft/inspector';
import type { IToolDefinition, IToolResponse } from '../server/tool-definition.ts';

const PROFILE_KINDS: readonly string[] = Object.values(ProfileKind);

/** THE kind parse for both tools: absent → no filter; a known kind; else an input error. */
function kindInput(input: Record<string, unknown>): { kind?: ProfileKind; error?: IToolResponse } {
  if (input.kind === undefined) return {};
  if (typeof input.kind === 'string' && isProfileKind(input.kind)) return { kind: input.kind };
  return {
    error: {
      isError: true,
      error: {
        code: 'invalid-input',
        message: `Unknown profile kind ${JSON.stringify(input.kind)} — known: ${PROFILE_KINDS.join(', ')}.`,
      },
    },
  };
}

export const listProfilesTool: IToolDefinition = {
  name: 'list_profiles',
  description:
    'List profiles: the builtin workspace vocabulary (WorkspaceProfile ids, `detected` per repo) and pack-contributed / locally configured migration profiles. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { kind: { type: 'string', enum: [...PROFILE_KINDS] } },
  },
  async handler(input, ctx) {
    const { kind, error } = kindInput(input);
    if (error) return error;
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
    properties: { id: { type: 'string' }, kind: { type: 'string', enum: [...PROFILE_KINDS] } },
  },
  async handler(input, ctx) {
    const id = typeof input.id === 'string' ? (input.id as string) : '';
    if (!id) return { isError: true, error: { code: 'invalid-input', message: 'id is required.' } };
    const { kind, error } = kindInput(input);
    if (error) return error;
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
