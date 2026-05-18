/**
 * Migration / readiness MCP tools. All read-only.
 */
import {
  buildMigrationReadiness,
  listMigrationProfiles,
  listMigrationProfilesFromPacks,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getMigrationReadinessTool: IToolDefinition = {
  name: 'get_migration_readiness',
  description:
    'Migration readiness verdict for a profile id. Read-only — probes local files and env vars; never runs source.',
  inputSchema: {
    type: 'object',
    properties: {
      profileId: { type: 'string' },
    },
    required: ['profileId'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const profileId =
      typeof input['profileId'] === 'string' ? (input['profileId'] as string) : '';
    const packProfiles = await listMigrationProfilesFromPacks(ctx.inspection);
    const report = buildMigrationReadiness({
      profileId,
      projectRoot: ctx.inspection.projectRoot,
      customProfiles: packProfiles,
    });
    return { data: report };
  },
};

export const listMigrationProfilesTool: IToolDefinition = {
  name: 'list_migration_profiles',
  description: 'List registered migration profiles (built-in + pack-contributed). Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const packProfiles = await listMigrationProfilesFromPacks(ctx.inspection);
    const profiles = listMigrationProfiles(packProfiles).map((p) => ({
      id: p.id,
      title: p.title,
      description: p.description,
      successVerdict: p.successVerdict,
      checks: p.checks.length,
    }));
    return { data: profiles };
  },
};
