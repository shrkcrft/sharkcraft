import { describe, expect, test } from 'bun:test';
import * as nodePath from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '../tools/index.ts';

const DOGFOOD_CWD = nodePath.resolve(__dirname, '../../../../examples/dogfood-target');

describe('MCP tool: smart_context_bundle', () => {
  test('is registered in ALL_TOOLS', () => {
    const names = new Set(ALL_TOOLS.map((t) => t.name));
    expect(names.has('smart_context_bundle')).toBe(true);
  });

  test('returns no-semantic-index error with a next-command hint when no index is built', async () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'smart_context_bundle')!;
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const res = await tool.handler(
      { task: 'add a new doctor check' },
      { inspection, cwd: DOGFOOD_CWD } as never,
    );
    const data = res.data as { error?: string; nextCommand?: string; message?: string };
    expect(data.error).toBe('no-semantic-index');
    expect(data.nextCommand).toContain('shrk smart-context embeddings-build');
    expect(typeof data.message).toBe('string');
  });

  test('rejects an empty task with an inline error (no inspection / index needed)', async () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'smart_context_bundle')!;
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const res = await tool.handler({ task: '   ' }, { inspection, cwd: DOGFOOD_CWD } as never);
    const data = res.data as { error?: string };
    expect(data.error).toContain('task is required');
  });
});
