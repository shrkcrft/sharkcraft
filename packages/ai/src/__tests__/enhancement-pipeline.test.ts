import { afterEach, describe, expect, test } from 'bun:test';
import { AppErrorImpl, ERROR_CODES, err, ok, type AppError, type Result } from '@shrkcrft/core';
import { AbstractAiProvider } from '../ai-provider.ts';
import type { IAiRequest, IAiResponse } from '../ai-request.ts';
import {
  EnhancementPipeline,
  EnhancementStageKind,
  buildDefaultEnhancementStages,
  buildFastEnhancementStages,
  type IEnhancementStage,
  type IEnhancementStageInput,
} from '../pipeline/enhancement-pipeline.ts';
import { AiMessageRole } from '../ai-request.ts';

class ScriptedProvider extends AbstractAiProvider {
  readonly id = 'scripted';
  readonly name = 'Scripted (test)';
  readonly calls: IAiRequest[] = [];
  private cursor = 0;

  constructor(private readonly responses: Array<Result<IAiResponse, AppError>>) {
    super();
  }

  async send(request: IAiRequest): Promise<Result<IAiResponse, AppError>> {
    this.calls.push(request);
    const next = this.responses[this.cursor];
    if (next === undefined) {
      return err(new AppErrorImpl(ERROR_CODES.IO_ERROR, 'no more scripted responses'));
    }
    this.cursor += 1;
    return next;
  }
}

function res(content: string, model = 'fake'): Result<IAiResponse, AppError> {
  return ok({ content, model, usage: { inputTokens: 1, outputTokens: 2 } });
}

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe('EnhancementPipeline', () => {
  test('returns the deterministic seed unchanged when no provider is passed', async () => {
    const pipeline = new EnhancementPipeline(buildDefaultEnhancementStages());
    const result = await pipeline.run(
      { task: 'add a thing', originalContext: 'DET-SEED' },
      null,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deterministicFallback).toBe(true);
    expect(result.value.finalOutput).toBe('DET-SEED');
    expect(result.value.stages).toEqual([]);
  });

  test('runs draft → critique → refine → polish and returns the polished output', async () => {
    const provider = new ScriptedProvider([
      res('DRAFT'),
      res('GAP: missing tests'),
      res('REFINED'),
      res('POLISHED'),
    ]);
    const pipeline = new EnhancementPipeline(buildDefaultEnhancementStages());
    const result = await pipeline.run(
      { task: 'add a thing', originalContext: 'CTX' },
      provider,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deterministicFallback).toBe(false);
    expect(result.value.finalOutput).toBe('POLISHED');
    expect(result.value.stages.map((s) => s.kind)).toEqual([
      EnhancementStageKind.Draft,
      EnhancementStageKind.Critique,
      EnhancementStageKind.Refine,
      EnhancementStageKind.Polish,
    ]);
    expect(provider.calls.length).toBe(4);
    // Total usage aggregates per-stage counts.
    expect(result.value.totalUsage.inputTokens).toBe(4);
    expect(result.value.totalUsage.outputTokens).toBe(8);
  });

  test('caps depth via maxPasses', async () => {
    const provider = new ScriptedProvider([res('DRAFT'), res('CRITIQUE')]);
    const pipeline = new EnhancementPipeline(buildDefaultEnhancementStages());
    const result = await pipeline.run(
      { task: 't', originalContext: 'CTX' },
      provider,
      { maxPasses: 2 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stages.map((s) => s.kind)).toEqual([
      EnhancementStageKind.Draft,
      EnhancementStageKind.Critique,
    ]);
    // After only draft + critique, the running best is the DRAFT
    // (critique is never promoted to finalOutput).
    expect(result.value.finalOutput).toBe('DRAFT');
  });

  test('degrades to the last-good output when a refine stage fails twice', async () => {
    const failure = err(new AppErrorImpl(ERROR_CODES.IO_ERROR, 'boom'));
    const provider = new ScriptedProvider([
      res('DRAFT'),
      res('GAP: x'),
      failure, // refine attempt 1
      failure, // refine retry
      res('POLISHED-OVER-DRAFT'),
    ]);
    const pipeline = new EnhancementPipeline(buildDefaultEnhancementStages());
    const result = await pipeline.run(
      { task: 't', originalContext: 'CTX' },
      provider,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Refine stage degraded → carry forward; polish ran on the draft.
    const refine = result.value.stages.find((s) => s.kind === EnhancementStageKind.Refine);
    expect(refine?.degraded).toBe(true);
    expect(result.value.finalOutput).toBe('POLISHED-OVER-DRAFT');
  });

  test('falls back to deterministic seed when every stage fails', async () => {
    const failure = err(new AppErrorImpl(ERROR_CODES.IO_ERROR, 'boom'));
    const provider = new ScriptedProvider([
      failure, failure, // draft + retry
      failure, failure, // critique + retry
      failure, failure, // refine + retry
      failure, failure, // polish + retry
    ]);
    const pipeline = new EnhancementPipeline(buildDefaultEnhancementStages());
    const result = await pipeline.run(
      { task: 't', originalContext: 'SEED' },
      provider,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.finalOutput).toBe('SEED');
    expect(result.value.stages.every((s) => s.degraded)).toBe(true);
  });

  test('emits per-stage progress through onStage', async () => {
    const provider = new ScriptedProvider([
      res('DRAFT'), res('CRITIQUE'), res('REFINED'), res('POLISHED'),
    ]);
    const events: string[] = [];
    const pipeline = new EnhancementPipeline(buildDefaultEnhancementStages());
    await pipeline.run(
      { task: 't', originalContext: 'CTX' },
      provider,
      { onStage: (e) => events.push(`${e.kind}:${e.ok}:${e.pass}/${e.total}`) },
    );
    expect(events).toEqual([
      'draft:true:1/4',
      'critique:true:2/4',
      'refine:true:3/4',
      'polish:true:4/4',
    ]);
  });

  test('buildFastEnhancementStages is draft → polish (2 calls)', async () => {
    const provider = new ScriptedProvider([res('DRAFT'), res('POLISHED')]);
    const pipeline = new EnhancementPipeline(buildFastEnhancementStages());
    const result = await pipeline.run({ task: 't', originalContext: 'CTX' }, provider);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stages.map((s) => s.kind)).toEqual([
      EnhancementStageKind.Draft,
      EnhancementStageKind.Polish,
    ]);
    expect(result.value.finalOutput).toBe('POLISHED');
    expect(provider.calls.length).toBe(2);
  });

  test('forwards an effective per-call timeout into each request', async () => {
    const provider = new ScriptedProvider([res('DRAFT'), res('POLISHED')]);
    const pipeline = new EnhancementPipeline(buildFastEnhancementStages());
    const result = await pipeline.run(
      { task: 't', originalContext: 'CTX' },
      provider,
      { budgetMs: 5000, perStageTimeoutMs: 1000 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // timeout = min(perStageTimeoutMs, remaining budget) = 1000.
    expect(provider.calls[0]?.timeoutMs).toBe(1000);
    expect(result.value.budgetExhausted).toBe(false);
  });

  test('stops before any stage when the budget is already too small', async () => {
    const provider = new ScriptedProvider([res('DRAFT')]);
    const pipeline = new EnhancementPipeline(buildFastEnhancementStages());
    const result = await pipeline.run(
      { task: 't', originalContext: 'SEED' },
      provider,
      { budgetMs: 100 }, // below the min-stage guard
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(provider.calls.length).toBe(0);
    expect(result.value.budgetExhausted).toBe(true);
    expect(result.value.finalOutput).toBe('SEED');
    expect(result.value.deterministicFallback).toBe(false);
  });

  test('does not retry a stage that timed out', async () => {
    const timeout = err(new AppErrorImpl(ERROR_CODES.TIMEOUT, 'too slow'));
    const provider = new ScriptedProvider([
      timeout, // draft times out — must NOT retry
      res('POLISHED-OVER-SEED'),
    ]);
    const pipeline = new EnhancementPipeline(buildFastEnhancementStages());
    const result = await pipeline.run({ task: 't', originalContext: 'SEED' }, provider);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // draft: 1 call (no retry on timeout); polish: 1 call → 2 total.
    expect(provider.calls.length).toBe(2);
    const draft = result.value.stages.find((s) => s.kind === EnhancementStageKind.Draft);
    expect(draft?.degraded).toBe(true);
    expect(result.value.finalOutput).toBe('POLISHED-OVER-SEED');
  });

  test('honours a custom stage list (caller can swap stages)', async () => {
    class EchoStage implements IEnhancementStage {
      readonly kind = EnhancementStageKind.Draft;
      buildMessages(input: IEnhancementStageInput) {
        return [
          { role: AiMessageRole.User, content: input.task + '|' + input.originalContext },
        ];
      }
    }
    const provider = new ScriptedProvider([res('CUSTOM-OUT')]);
    const pipeline = new EnhancementPipeline([new EchoStage()]);
    const result = await pipeline.run(
      { task: 'do thing', originalContext: 'CTX' },
      provider,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.finalOutput).toBe('CUSTOM-OUT');
    expect(provider.calls[0]?.messages[0]?.content).toBe('do thing|CTX');
  });
});
