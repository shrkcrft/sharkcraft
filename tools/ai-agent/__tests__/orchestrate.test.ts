import { afterAll, beforeAll, describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { orchestrate } from '../src/orchestrate.ts';
import type { IIssueEvent } from '../src/gate.ts';
import { AgentError, ErrorCategory } from '../src/errors.ts';
import type { IAgentRunner } from '../src/runner/types.ts';

// Generic test fixture login — see gate.test.ts for the rationale.
const TEST_ACTOR = 'repo-owner';
const savedAllowed = process.env['SHARKCRAFT_AI_ALLOWED_ACTORS'];
const savedMaintainers = process.env['SHARKCRAFT_AI_MAINTAINERS'];
beforeAll(() => {
  process.env['SHARKCRAFT_AI_ALLOWED_ACTORS'] = TEST_ACTOR;
  process.env['SHARKCRAFT_AI_MAINTAINERS'] = TEST_ACTOR;
});
afterAll(() => {
  if (savedAllowed === undefined) delete process.env['SHARKCRAFT_AI_ALLOWED_ACTORS'];
  else process.env['SHARKCRAFT_AI_ALLOWED_ACTORS'] = savedAllowed;
  if (savedMaintainers === undefined) delete process.env['SHARKCRAFT_AI_MAINTAINERS'];
  else process.env['SHARKCRAFT_AI_MAINTAINERS'] = savedMaintainers;
});

function event(
  overrides: Partial<Omit<IIssueEvent, 'issue'>> & { issue?: Partial<IIssueEvent['issue']> } = {},
): IIssueEvent {
  const { issue: issueOverride, ...rest } = overrides;
  return {
    action: 'opened',
    issue: {
      number: 42,
      title: '[AI] do a thing',
      body: 'body text',
      user: { login: 'repo-owner' },
      ...issueOverride,
    },
    ...rest,
  };
}

function fakeFetch(responses: Response[]): typeof fetch {
  let i = 0;
  return (async () => {
    const r = responses[i] ?? new Response('', { status: 500 });
    i += 1;
    return r;
  }) as unknown as typeof fetch;
}

function okResponse(): Response {
  return new Response(JSON.stringify({ id: 'c' }), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });
}

function failResponse(status: number): Response {
  return new Response('boom', { status });
}

class StubRunner implements IAgentRunner {
  constructor(private readonly impl: IAgentRunner['run']) {}
  run(input: Parameters<IAgentRunner['run']>[0]) {
    return this.impl(input);
  }
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.GITHUB_TOKEN = 'test-token';
  process.env.GITHUB_REPOSITORY = 'owner/repo';
  process.env.GITHUB_SERVER_URL = 'https://github.com';
  process.env.GITHUB_RUN_ID = '12345';
  // The gate reads these per-call; restore them every test in case a
  // prior afterEach reset the env to the pre-test snapshot.
  process.env['SHARKCRAFT_AI_ALLOWED_ACTORS'] = TEST_ACTOR;
  process.env['SHARKCRAFT_AI_MAINTAINERS'] = TEST_ACTOR;
  delete process.env.GITHUB_STEP_SUMMARY;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('orchestrate — gate outcomes', () => {
  test('ignore decision returns ignored without runner call', async () => {
    let called = false;
    const runner = new StubRunner(async () => {
      called = true;
      throw new Error('should not be called');
    });
    const result = await orchestrate(event({ issue: { user: { login: 'stranger' } } }), {
      runner,
      writeStepSummaryFn: () => {},
    });
    expect(result.kind).toBe('ignored');
    expect(called).toBe(false);
  });

  test('implement decision returns ignored without runner call', async () => {
    let called = false;
    const runner = new StubRunner(async () => {
      called = true;
      throw new Error('should not be called');
    });
    const result = await orchestrate(
      event({
        action: 'labeled',
        label: { name: 'ai:implement' },
        sender: { login: 'repo-owner' },
      }),
      { runner, writeStepSummaryFn: () => {} },
    );
    expect(result.kind).toBe('ignored');
    if (result.kind === 'ignored') {
      expect(result.reason).toContain('Phase 2');
    }
    expect(called).toBe(false);
  });
});

describe('orchestrate — plan path', () => {
  test('happy path posts a comment with telemetry footer', async () => {
    let postedBody = '';
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      postedBody = init?.body ? String(init.body) : '';
      return okResponse();
    }) as unknown as typeof fetch;

    const runner = new StubRunner(async () => ({
      commentMarkdown: '## AI Plan\n\nSummary: test.',
      telemetry: {
        modelId: 'claude-opus-4-7',
        inputTokens: 100,
        outputTokens: 200,
        durationMs: 50,
      },
    }));

    const result = await orchestrate(event({}), {
      runner,
      fetchFn,
      collectContextFn: async () => ({ shrkTaskOutput: 'fake context' }),
      writeStepSummaryFn: () => {},
    });

    expect(result.kind).toBe('success');
    expect(postedBody).toContain('AI Plan');
    expect(postedBody).toContain('mode: plan');
    expect(postedBody).toContain('claude-opus-4-7');
    expect(postedBody).toContain('~300');
  });
});

describe('orchestrate — failure handling', () => {
  test('runner timeout posts failure comment with runner_timeout category', async () => {
    const fetchCalls: string[] = [];
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      fetchCalls.push(init?.body ? String(init.body) : '');
      return okResponse();
    }) as unknown as typeof fetch;

    const runner = new StubRunner(async () => {
      throw new AgentError(ErrorCategory.RunnerTimeout, 'timed out');
    });

    const result = await orchestrate(event({}), {
      runner,
      fetchFn,
      collectContextFn: async () => ({ shrkTaskOutput: '' }),
      writeStepSummaryFn: () => {},
    });

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.category).toBe(ErrorCategory.RunnerTimeout);
    }
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]).toContain('runner_timeout');
    expect(fetchCalls[0]).toContain('AI Run Failed');
  });

  test('context collection failure posts context_collection_failed comment', async () => {
    const fetchCalls: string[] = [];
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      fetchCalls.push(init?.body ? String(init.body) : '');
      return okResponse();
    }) as unknown as typeof fetch;

    const runner = new StubRunner(async () => {
      throw new Error('should not be called');
    });

    const result = await orchestrate(event({}), {
      runner,
      fetchFn,
      collectContextFn: async () => {
        throw new AgentError(ErrorCategory.ContextCollectionFailed, 'no shrk');
      },
      writeStepSummaryFn: () => {},
    });

    expect(result.kind).toBe('failure');
    expect(fetchCalls[0]).toContain('context_collection_failed');
  });

  test('comment post failure returns failure without double-posting', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return failResponse(500);
    }) as unknown as typeof fetch;

    const runner = new StubRunner(async () => ({
      commentMarkdown: '## AI Plan\n\nbody',
      telemetry: { modelId: 'claude-opus-4-7', inputTokens: 1, outputTokens: 1, durationMs: 1 },
    }));

    const result = await orchestrate(event({}), {
      runner,
      fetchFn,
      collectContextFn: async () => ({ shrkTaskOutput: '' }),
      writeStepSummaryFn: () => {},
    });

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.category).toBe(ErrorCategory.CommentPostFailed);
    }
    // Only the original comment attempt; no fallback failure comment posted.
    expect(calls).toBe(1);
  });

  test('unknown thrown value classifies as unknown_error', async () => {
    const fetchCalls: string[] = [];
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      fetchCalls.push(init?.body ? String(init.body) : '');
      return okResponse();
    }) as unknown as typeof fetch;

    const runner = new StubRunner(async () => {
      throw 'plain string error';
    });

    const result = await orchestrate(event({}), {
      runner,
      fetchFn,
      collectContextFn: async () => ({ shrkTaskOutput: '' }),
      writeStepSummaryFn: () => {},
    });

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.category).toBe(ErrorCategory.UnknownError);
    }
    expect(fetchCalls[0]).toContain('unknown_error');
  });
});

// fakeFetch helper kept for callers that may want a sequenced response queue.
// Currently unused; importing it would error under strict noUnusedLocals.
void fakeFetch;
