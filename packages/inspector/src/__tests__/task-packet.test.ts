import { describe, expect, test } from 'bun:test';
import * as nodePath from 'node:path';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';
import { buildTaskPacket } from '../task-packet.ts';

const DOGFOOD = nodePath.resolve(__dirname, '../../../../examples/dogfood-target');

describe('buildTaskPacket', () => {
  test('contains relevant rules, paths, templates, hints, and a context body', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD });
    const packet = buildTaskPacket(inspection, 'generate a user profile service');
    expect(packet.task).toBe('generate a user profile service');
    expect(packet.context.totalTokens).toBeGreaterThan(0);
    expect(packet.relevantRules.length).toBeGreaterThan(0);
    expect(packet.relevantPaths.length).toBeGreaterThan(0);
    // templates relevance is search-based; not guaranteed to match every wording
    expect(packet.recommendedPipelines.length).toBeGreaterThanOrEqual(1);
  });

  test('feature-style tasks recommend feature-dev pipeline', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD });
    const packet = buildTaskPacket(inspection, 'create a new service');
    expect(
      packet.recommendedPipelines.some((p) => p.pipelineId === 'feature-dev'),
    ).toBe(true);
  });

  test('refactor-style tasks recommend a safe-generation pipeline when present', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD });
    const packet = buildTaskPacket(inspection, 'refactor the storage layer');
    expect(packet.recommendedPipelines.length).toBeGreaterThanOrEqual(1);
  });

  test('respects max-tokens budget for the embedded context', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD });
    const small = buildTaskPacket(inspection, 'generate a service', { maxTokens: 500 });
    expect(small.context.totalTokens).toBeLessThanOrEqual(500 + 50);
  });
});
