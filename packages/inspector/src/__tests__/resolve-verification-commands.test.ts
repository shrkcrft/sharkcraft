import { describe, expect, test } from 'bun:test';
import { PipelineStepType, type IPipelineStep } from '@shrkcrft/pipelines';
import { resolveVerificationCommands } from '../resolve-verification-commands.ts';
import type { ISharkcraftInspection } from '../sharkcraft-inspector.ts';

function stub(opts: {
  pipelines?: Record<string, { steps: IPipelineStep[] }>;
  verificationCommands?: { id: string; command: string }[];
}): ISharkcraftInspection {
  return {
    pipelineRegistry: { get: (id: string) => opts.pipelines?.[id] ?? undefined },
    config: opts.verificationCommands ? { verificationCommands: opts.verificationCommands } : null,
  } as unknown as ISharkcraftInspection;
}

const step = (over: Partial<IPipelineStep>): IPipelineStep => ({
  id: over.id ?? 's',
  type: over.type ?? PipelineStepType.Command,
  ...over,
});

describe('resolveVerificationCommands', () => {
  test('prefers the matched pipeline gates and skips non-gate command steps', () => {
    const inspection = stub({
      pipelines: {
        'engine.feature-dev': {
          steps: [
            step({ id: 'typecheck', type: PipelineStepType.Command, required: true, cliCommands: ['bun x tsc --noEmit'] }),
            step({ id: 'test', type: PipelineStepType.Command, required: true, cliCommands: ['bun test'] }),
            // required:false → optional review, excluded
            step({ id: 'plan-review', type: PipelineStepType.Command, required: false, cliCommands: ['shrk plan review /tmp/plan.json'] }),
            // placeholder token → generative/spec step, excluded
            step({ id: 'spec', type: PipelineStepType.Command, required: true, cliCommands: ['shrk spec create "<task>" --write'] }),
            // non-command type → excluded
            step({ id: 'apply', type: PipelineStepType.ApplyPlan, cliCommands: ['shrk apply /tmp/plan.json'] }),
          ],
        },
      },
      verificationCommands: [{ id: 'x', command: 'make verify' }],
    });
    expect(
      resolveVerificationCommands(inspection, {
        pipelineIds: ['engine.feature-dev'],
        knowledgeDefaults: ['git status --short'],
      }),
    ).toEqual(['bun x tsc --noEmit', 'bun test']);
  });

  test('falls back to config verificationCommands when no pipeline gates', () => {
    const inspection = stub({ verificationCommands: [{ id: 'v', command: 'make verify' }] });
    expect(
      resolveVerificationCommands(inspection, { pipelineIds: [], knowledgeDefaults: ['git status'] }),
    ).toEqual(['make verify']);
  });

  test('falls back to knowledge defaults when neither pipeline nor config declares gates', () => {
    const inspection = stub({});
    expect(
      resolveVerificationCommands(inspection, { knowledgeDefaults: ['echo hi', 'echo hi'] }),
    ).toEqual(['echo hi']);
  });

  test('returns empty when nothing is available', () => {
    expect(resolveVerificationCommands(stub({}), {})).toEqual([]);
  });
});
