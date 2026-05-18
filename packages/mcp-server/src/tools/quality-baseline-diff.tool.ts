import { diffQualityBaselineFiles } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getQualityBaselineDiffTool: IToolDefinition = {
  name: 'get_quality_baseline_diff',
  description:
    'Diff two quality baseline JSON files. Returns score/blockers/warnings/category deltas. Read-only.',
  inputSchema: {
    type: 'object',
    required: ['oldFile', 'newFile'],
    properties: { oldFile: { type: 'string' }, newFile: { type: 'string' } },
  },
  handler(input) {
    const oldFile = String(input['oldFile'] ?? '');
    const newFile = String(input['newFile'] ?? '');
    const diff = diffQualityBaselineFiles(oldFile, newFile);
    if (!diff) return { error: { code: 'not-found', message: 'Could not load both baselines' } };
    return { data: diff };
  },
};
