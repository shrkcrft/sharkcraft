import {
  previewResolvedPresetApplication,
  resolvePreset,
  resolvePresetReferences,
} from '@shrkcrft/presets';
import { inspectionReferenceLookup } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const previewPresetApplicationTool: IToolDefinition = {
  name: 'preview_preset_application',
  description:
    'Preview what a preset would write into the target sharkcraft/ folder. **This tool never writes.** Returns the resolved composition chain, referenced asset status, missing references, files that would be created, and the exact CLI command a human should run to apply or patch.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      force: { type: 'boolean' },
      merge: { type: 'boolean' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const id = String((input as { id?: unknown }).id ?? '');
    const force = (input as { force?: unknown }).force === true;
    const merge = (input as { merge?: unknown }).merge === true;
    if (!ctx.inspection.presetRegistry.has(id)) {
      return { isError: true, text: `No preset with id "${id}".` };
    }
    const resolved = resolvePreset(ctx.inspection.presetRegistry, id);
    const references = resolvePresetReferences(
      resolved,
      inspectionReferenceLookup(ctx.inspection),
    );
    const plan = previewResolvedPresetApplication(resolved, {
      projectRoot: ctx.inspection.projectRoot,
      force,
      merge,
    });

    const missingFiles = plan.entries.filter((e) => e.status === 'create').map((e) => e.relPath);
    const existingFiles = plan.entries
      .filter((e) => e.status === 'skip-existing')
      .map((e) => e.relPath);

    const applyCommand =
      'shrk presets apply ' +
      id +
      ' --write' +
      (force ? ' --force' : '') +
      (merge ? ' --merge' : '');
    const patchCommand = 'shrk presets patch ' + id + ' --write';

    return {
      data: {
        presetId: resolved.rootId,
        composedFrom: resolved.composedFrom,
        compositionIssues: resolved.issues,
        references,
        sharkcraftDir: plan.sharkcraftDir,
        files: plan.entries.map((e) => ({
          path: e.relPath,
          status: e.status,
          kind: e.kind,
        })),
        diff: {
          missingFiles,
          existingFiles,
          missingRefs: references.missing,
        },
        warnings: plan.warnings,
        humanRunsApply: applyCommand,
        humanRunsPatch: patchCommand,
        note:
          'MCP servers are read-only. To apply this preset, ask the human to run the apply or patch command above.',
      },
    };
  },
};
