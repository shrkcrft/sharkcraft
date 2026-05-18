import { describe, expect, test } from "bun:test";
import {
  definePipeline,
  formatPipelineCompact,
  formatPipelineFull,
  PipelineRegistry,
  PipelineStepType
} from '../index.ts';

const featureDev = definePipeline({
  id: 'feature-dev',
  title: 'Feature dev',
  description: 'Build context, plan, apply, verify.',
  tags: ['feature'],
  appliesWhen: ['create-feature'],
  inputs: [{ name: 'task', required: true }],
  steps: [
    {
      id: 'context',
      type: PipelineStepType.Context,
      mcpTools: ['get_relevant_context'],
      required: true,
    },
    {
      id: 'plan',
      type: PipelineStepType.GenerationPlan,
      mcpTools: ['create_generation_plan'],
      humanReview: true,
    },
    {
      id: 'apply',
      type: PipelineStepType.ApplyPlan,
      cliCommands: ['shrk apply <plan.json>'],
    },
  ],
});

const tinyVerify = definePipeline({
  id: 'verify-tiny',
  title: 'Verify',
  description: 'Just run bun test.',
  tags: ['test', 'verify'],
  appliesWhen: ['verify'],
  steps: [{ id: 'bun-test', type: PipelineStepType.Command, cliCommands: ['bun test'] }],
});

describe('definePipeline validation', () => {
  test('rejects missing id', () => {
    expect(() =>
      definePipeline({ id: '', title: 't', description: 'd', steps: [{ id: 'a', type: 'context' }] }),
    ).toThrow();
  });

  test('rejects empty steps', () => {
    expect(() =>
      definePipeline({ id: 'x', title: 't', description: 'd', steps: [] as never }),
    ).toThrow();
  });

  test('rejects duplicate step ids', () => {
    expect(() =>
      definePipeline({
        id: 'x',
        title: 't',
        description: 'd',
        steps: [
          { id: 'a', type: 'context' },
          { id: 'a', type: 'command' },
        ],
      }),
    ).toThrow();
  });
});

describe('PipelineRegistry', () => {
  test('register/get/list', () => {
    const reg = new PipelineRegistry([featureDev, tinyVerify]);
    expect(reg.has('feature-dev')).toBe(true);
    expect(reg.get('verify-tiny')?.title).toBe('Verify');
    expect(reg.list().length).toBe(2);
  });

  test('search filters by query', () => {
    const reg = new PipelineRegistry([featureDev, tinyVerify]);
    expect(reg.search('verify').some((p) => p.id === 'verify-tiny')).toBe(true);
    expect(reg.search('feature').some((p) => p.id === 'feature-dev')).toBe(true);
  });

  test('relevantFor ranks by tag/appliesWhen match', () => {
    const reg = new PipelineRegistry([featureDev, tinyVerify]);
    const r = reg.relevantFor('create-feature widget');
    expect(r[0]?.id).toBe('feature-dev');
  });
});

describe('formatPipeline', () => {
  test('compact returns single-line summary', () => {
    expect(formatPipelineCompact(featureDev)).toContain('feature-dev');
    expect(formatPipelineCompact(featureDev)).toContain('3 steps');
  });

  test('full renders steps with type + cli/mcp lines', () => {
    const out = formatPipelineFull(featureDev);
    expect(out).toContain('## Steps');
    expect(out).toContain('[context]');
    expect(out).toContain('mcpTools: get_relevant_context');
    expect(out).toContain('$ shrk apply <plan.json>');
  });
});
