import { describe, expect, test } from 'bun:test';
import { AppErrorImpl, ERROR_CODES, err, ok, type AppError, type Result } from '@shrkcrft/core';
import type { IAiProvider, IAiRequest, IAiResponse } from '@shrkcrft/ai';
import type { IGroundingFacts, IResolvedDelegateRecipe } from '@shrkcrft/inspector';
import { executeDelegateAnalyze } from '../commands/delegate.command.ts';

const GENERATED_AT = '2026-07-03T00:00:00.000Z';

const FACTS: IGroundingFacts = {
  groundedOn: 'task-risk',
  summary: 'Task risk: high (score 20).',
  entities: ['src/foo.ts', 'high-fan-in-file'],
  raw: null,
};

function analysisRecipe(over: Partial<IResolvedDelegateRecipe> = {}): IResolvedDelegateRecipe {
  return {
    id: 'arch-risk-review',
    title: 'Arch risk review',
    mode: 'analysis',
    groundedOn: 'task-risk',
    resolvedProvider: 'auto',
    guardrailGlobs: [],
    allowedOps: [],
    verificationIds: [],
    unboundVerificationIds: [],
    verificationBound: false,
    groundingBound: true,
    delegatable: true,
    source: 'config',
    ...over,
  };
}

/** A provider that returns canned findings — deterministic for tests. */
function fakeAnalysisProvider(findings: unknown[], note?: string): IAiProvider {
  return {
    id: 'fake',
    name: 'fake',
    configure() {},
    isReady() {
      return true;
    },
    async send(_request: IAiRequest): Promise<Result<IAiResponse, AppError>> {
      return ok({ content: JSON.stringify({ findings, ...(note ? { note } : {}) }), model: 'fake-model' });
    },
  };
}

/** A provider that returns scripted content per call (for the query loop). */
function scriptedProvider(contents: string[]): IAiProvider {
  let i = 0;
  return {
    id: 'sc',
    name: 'sc',
    configure() {},
    isReady() {
      return true;
    },
    async send(): Promise<Result<IAiResponse, AppError>> {
      const c = contents[Math.min(i, contents.length - 1)] ?? '';
      i += 1;
      return ok({ content: c, model: 'fake-model' });
    },
  };
}

/** A provider whose send always errors. */
function failingProvider(): IAiProvider {
  return {
    id: 'fail',
    name: 'fail',
    configure() {},
    isReady() {
      return true;
    },
    async send(): Promise<Result<IAiResponse, AppError>> {
      return err(new AppErrorImpl(ERROR_CODES.INVALID_INPUT, 'boom'));
    },
  };
}

describe('executeDelegateAnalyze', () => {
  test('no provider → deterministic grounding-only report, ok, writes nothing', async () => {
    const result = await executeDelegateAnalyze({
      task: 'refactor the loader',
      recipe: analysisRecipe(),
      facts: FACTS,
      provider: null,
      providerLabel: 'none',
      generatedAt: GENERATED_AT,
    });
    expect(result.status).toBe('no-provider');
    expect(result.report.mode).toBe('analysis');
    expect(result.report.findings).toHaveLength(0);
    expect(result.report.provider).toBe('none');
    // Structurally read-only: the result exposes no write side-effect fields.
    expect('written' in result).toBe(false);
    expect('planPath' in result).toBe(false);
  });

  test('grounded and fabricated findings are tagged by the cross-check', async () => {
    const result = await executeDelegateAnalyze({
      task: 't',
      recipe: analysisRecipe(),
      facts: FACTS,
      provider: fakeAnalysisProvider([
        { message: 'real risk', refs: ['src/foo.ts'] },
        { message: 'invented', refs: ['src/ghost.ts'] },
      ]),
      providerLabel: 'ollama',
      generatedAt: GENERATED_AT,
    });
    expect(result.status).toBe('analyzed');
    expect(result.report.groundedCount).toBe(1);
    expect(result.report.unverifiedCount).toBe(1);
    expect(result.report.provider).toBe('fake-model');
  });

  test('strict grounding drops fabricated findings', async () => {
    const result = await executeDelegateAnalyze({
      task: 't',
      recipe: analysisRecipe(),
      facts: FACTS,
      provider: fakeAnalysisProvider([
        { message: 'real', refs: ['src/foo.ts'] },
        { message: 'invented', refs: ['src/ghost.ts'] },
      ]),
      strict: true,
      providerLabel: 'ollama',
      generatedAt: GENERATED_AT,
    });
    expect(result.report.findings).toHaveLength(1);
    expect(result.report.findings[0]?.message).toBe('real');
  });

  test('a model failure degrades to grounding-only with a note (status analyze-failed)', async () => {
    const result = await executeDelegateAnalyze({
      task: 't',
      recipe: analysisRecipe(),
      facts: FACTS,
      provider: failingProvider(),
      providerLabel: 'ollama',
      generatedAt: GENERATED_AT,
    });
    expect(result.status).toBe('analyze-failed');
    expect(result.report.findings).toHaveLength(0);
    expect(result.report.modelNote).toContain('model failed');
  });
});

describe('executeDelegateAnalyze — bounded query loop (Phase 3)', () => {
  test('the model pulls a read-only fact, and a finding citing it is grounded', async () => {
    const result = await executeDelegateAnalyze({
      task: 't',
      recipe: analysisRecipe({ allowedQueries: ['coverage'], maxQueryRounds: 1 }),
      facts: FACTS, // does NOT contain 'cov-cat' — only the query surfaces it
      provider: scriptedProvider([
        '{"done":false,"queries":[{"name":"coverage","args":{}}]}',
        '{"findings":[{"message":"weak coverage","refs":["cov-cat"]}]}',
      ]),
      queryExecutor: async () => ({ content: 'overall 50%', entities: ['cov-cat'] }),
      providerLabel: 'ollama',
      generatedAt: GENERATED_AT,
    });
    expect(result.status).toBe('analyzed');
    expect(result.report.queriesRun).toBe(1);
    // The finding cites an entity that only the query surfaced → still grounded.
    expect(result.report.groundedCount).toBe(1);
    expect(result.report.unverifiedCount).toBe(0);
  });

  test('a recipe with allowedQueries but no injected executor falls back to single-shot', async () => {
    const result = await executeDelegateAnalyze({
      task: 't',
      recipe: analysisRecipe({ allowedQueries: ['coverage'], maxQueryRounds: 1 }),
      facts: FACTS,
      provider: fakeAnalysisProvider([{ message: 'x', refs: ['src/foo.ts'] }]),
      // no queryExecutor
      providerLabel: 'ollama',
      generatedAt: GENERATED_AT,
    });
    expect(result.status).toBe('analyzed');
    expect(result.report.queriesRun).toBeUndefined();
  });
});

describe('executeDelegateAnalyze — fan-out (Phase 4)', () => {
  // FACTS has 2 entities → maxFanOut 2 ⇒ 2 deterministic slices, one pass each.
  test('runs a pass per slice, merges findings in deterministic order', async () => {
    const result = await executeDelegateAnalyze({
      task: 't',
      recipe: analysisRecipe({ fanOut: true, maxFanOut: 2 }),
      facts: FACTS,
      provider: scriptedProvider([
        '{"findings":[{"message":"A","refs":["src/foo.ts"]}]}',
        '{"findings":[{"message":"B","refs":["high-fan-in-file"]}]}',
      ]),
      providerLabel: 'ollama',
      generatedAt: GENERATED_AT,
    });
    expect(result.status).toBe('analyzed');
    expect(result.report.fanOutSlices).toBe(2);
    expect(result.report.findings.map((f) => f.message)).toEqual(['A', 'B']);
    expect(result.report.groundedCount).toBe(2);
  });

  test('duplicate findings across slices are deduped', async () => {
    const result = await executeDelegateAnalyze({
      task: 't',
      recipe: analysisRecipe({ fanOut: true, maxFanOut: 2 }),
      facts: FACTS,
      provider: scriptedProvider([
        '{"findings":[{"message":"same risk","refs":["src/foo.ts"]}]}',
        '{"findings":[{"message":"same risk","refs":["src/foo.ts"]}]}',
      ]),
      providerLabel: 'ollama',
      generatedAt: GENERATED_AT,
    });
    expect(result.report.findings).toHaveLength(1);
  });

  test('no fan-out when the grounding has fewer than 2 entities', async () => {
    const result = await executeDelegateAnalyze({
      task: 't',
      recipe: analysisRecipe({ fanOut: true }),
      facts: { groundedOn: 'task-risk', summary: 's', entities: ['only-one'], raw: null },
      provider: fakeAnalysisProvider([{ message: 'single', refs: ['only-one'] }]),
      providerLabel: 'ollama',
      generatedAt: GENERATED_AT,
    });
    expect(result.report.fanOutSlices).toBeUndefined(); // fell through to single-shot
  });
});

describe('executeDelegateAnalyze — escalation hint (Phase 4)', () => {
  test('a recipe with escalateTo surfaces an advisory next-command when findings exist', async () => {
    const result = await executeDelegateAnalyze({
      task: 't',
      recipe: analysisRecipe({ escalateTo: 'scaffold-test-stub' }),
      facts: FACTS,
      provider: fakeAnalysisProvider([{ message: 'missing a test', refs: ['src/foo.ts'] }]),
      providerLabel: 'ollama',
      generatedAt: GENERATED_AT,
    });
    expect(result.report.escalation?.recipe).toBe('scaffold-test-stub');
    expect(result.report.escalation?.next).toContain('--recipe scaffold-test-stub');
  });

  test('no escalation hint when there are no findings', async () => {
    const result = await executeDelegateAnalyze({
      task: 't',
      recipe: analysisRecipe({ escalateTo: 'scaffold-test-stub' }),
      facts: FACTS,
      provider: fakeAnalysisProvider([]),
      providerLabel: 'ollama',
      generatedAt: GENERATED_AT,
    });
    expect(result.report.escalation).toBeUndefined();
  });
});
