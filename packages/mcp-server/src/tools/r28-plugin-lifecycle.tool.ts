/**
 * Plan-only plugin lifecycle previews (profile-driven).
 *
 *  preview_plugin_rename — returns the rename plan (replace ops + manual steps).
 *  preview_plugin_remove — returns the destructive remove plan.
 *
 *  Both tools never write source — the human runs `shrk plugin rename|remove`
 *  to produce the saved plan and applies it via `shrk apply --verify-signature`.
 *
 *  A `profile` input is required. If exactly one lifecycle profile is
 *  registered, the tool implicitly uses it; otherwise the caller must supply
 *  `profile`.
 */
import {
  buildPluginRemovePlan,
  buildPluginRenamePlan,
  resolvePluginLifecycleProfile,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

function nextHint(cmd: string): string {
  return `Next: \`${cmd}\` (CLI is the only write path).`;
}

export const previewPluginRenameTool: IToolDefinition = {
  name: 'preview_plugin_rename',
  description:
    'Preview a plugin rename plan. Read-only — returns the structured plan only. Requires a registered plugin lifecycle profile (pass `profile` if more than one is registered).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['oldName', 'newName'],
    properties: {
      oldName: { type: 'string' },
      newName: { type: 'string' },
      profile: { type: 'string' },
    },
  },
  async handler(input, ctx) {
    const oldName = String(input.oldName ?? '');
    const newName = String(input.newName ?? '');
    const profileId = typeof input.profile === 'string' ? input.profile : undefined;
    const resolved = await resolvePluginLifecycleProfile(ctx.inspection, {
      profileId,
      allowSingleDefault: true,
    });
    if (!resolved.entry) {
      return {
        isError: true,
        error: { code: 'profile-required', message: resolved.error ?? 'Profile resolution failed' },
        data: { availableProfiles: resolved.availableIds },
      };
    }
    const plan = buildPluginRenamePlan({
      projectRoot: ctx.cwd,
      profile: resolved.entry.profile,
      oldName,
      newName,
    });
    return {
      text: nextHint(
        `shrk plugin rename ${oldName} ${newName} --profile ${resolved.entry.profile.id} --output /tmp/plan.json`,
      ),
      data: plan,
    };
  },
};

export const previewPluginRemoveTool: IToolDefinition = {
  name: 'preview_plugin_remove',
  description:
    'Preview a destructive plugin remove plan. Read-only — returns the structured plan only. Requires a registered plugin lifecycle profile (pass `profile` if more than one is registered).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    properties: {
      name: { type: 'string' },
      profile: { type: 'string' },
    },
  },
  async handler(input, ctx) {
    const name = String(input.name ?? '');
    const profileId = typeof input.profile === 'string' ? input.profile : undefined;
    const resolved = await resolvePluginLifecycleProfile(ctx.inspection, {
      profileId,
      allowSingleDefault: true,
    });
    if (!resolved.entry) {
      return {
        isError: true,
        error: { code: 'profile-required', message: resolved.error ?? 'Profile resolution failed' },
        data: { availableProfiles: resolved.availableIds },
      };
    }
    const plan = buildPluginRemovePlan({
      projectRoot: ctx.cwd,
      profile: resolved.entry.profile,
      oldName: name,
    });
    return {
      text: nextHint(
        `shrk plugin remove ${name} --profile ${resolved.entry.profile.id} --output /tmp/plan.json`,
      ),
      data: plan,
    };
  },
};
