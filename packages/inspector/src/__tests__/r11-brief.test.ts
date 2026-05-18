import { describe, expect, test } from 'bun:test';
import * as nodePath from 'node:path';
import { BriefMode, buildAgentBrief, inspectSharkcraft } from '../index.ts';

const DOGFOOD_CWD = nodePath.resolve(__dirname, '../../../../examples/dogfood-target');

describe('r11 agent brief', () => {
  test('markdown contains task + safety note', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const brief = await buildAgentBrief(inspection, { task: 'generate a user profile service' });
    expect(brief.schema).toBe('sharkcraft.agent-brief/v1');
    expect(brief.markdown).toContain('generate a user profile service');
    expect(brief.markdown).toContain('MCP is read-only');
  });

  test('review mode without task uses --files', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const brief = await buildAgentBrief(inspection, { files: ['src/services/user.service.ts'] });
    expect(brief.mode).toBe(BriefMode.Review);
    expect(brief.sections.some((s) => s.id === 'impact')).toBe(true);
  });

  test('compact mode trims sections', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const brief = await buildAgentBrief(inspection, {
      task: 'generate a user profile service',
      mode: BriefMode.Compact,
    });
    // Compact omits forbidden / impact / coverage detail.
    const ids = new Set(brief.sections.map((s) => s.id));
    expect(ids.has('rules')).toBe(true);
    expect(ids.has('forbidden')).toBe(false);
    expect(ids.has('coverage')).toBe(false);
  });

  test('json shape exposes suggestedCommands + inputs', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const brief = await buildAgentBrief(inspection, { task: 't' });
    expect(Array.isArray(brief.suggestedCommands)).toBe(true);
    expect(brief.inputs.staged).toBe(false);
  });
});
