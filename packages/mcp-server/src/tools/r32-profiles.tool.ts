/**
 * Read-only MCP tools for profiles + lifecycle profiles.
 *
 * Engine never writes from MCP. These tools surface pack-contributed and
 * locally configured profiles so an agent can decide which one to pass to
 * `shrk plugin rename|remove --profile <id>` (the human runs the CLI).
 */
import {
  checkPluginLifecycleProfileHealth,
  findProfile,
  listProfileIssues,
  listProfiles,
  listPluginLifecycleProfiles,
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

export const listPluginLifecycleProfilesTool: IToolDefinition = {
  name: 'list_plugin_lifecycle_profiles',
  description: 'List registered plugin lifecycle profiles. Read-only.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  async handler(_input, ctx) {
    return { data: await listPluginLifecycleProfiles(ctx.inspection) };
  },
};

export const getPluginLifecycleProfileTool: IToolDefinition = {
  name: 'get_plugin_lifecycle_profile',
  description: 'Get one plugin lifecycle profile by id. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'string' } },
  },
  async handler(input, ctx) {
    const id = typeof input.id === 'string' ? (input.id as string) : '';
    if (!id) return { isError: true, error: { code: 'invalid-input', message: 'id is required.' } };
    const entries = await listPluginLifecycleProfiles(ctx.inspection);
    const entry = entries.find((e) => e.profile.id === id);
    if (!entry) {
      return { isError: true, error: { code: 'not-found', message: `Unknown lifecycle profile "${id}".` } };
    }
    return { data: entry };
  },
};

export const getPluginLifecycleProfileDoctorTool: IToolDefinition = {
  name: 'get_plugin_lifecycle_profile_doctor',
  description: 'Health check for plugin lifecycle profiles. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { id: { type: 'string' } },
  },
  async handler(input, ctx) {
    const id = typeof input.id === 'string' ? (input.id as string) : undefined;
    const entries = await listPluginLifecycleProfiles(ctx.inspection);
    const targets = id ? entries.filter((e) => e.profile.id === id) : entries;
    if (id && targets.length === 0) {
      return { isError: true, error: { code: 'not-found', message: `Unknown lifecycle profile "${id}".` } };
    }
    const health: Record<string, ReturnType<typeof checkPluginLifecycleProfileHealth>> = {};
    for (const e of targets) {
      health[e.profile.id] = checkPluginLifecycleProfileHealth(ctx.cwd, e.profile);
    }
    return { data: { health } };
  },
};
