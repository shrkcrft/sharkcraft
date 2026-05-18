import { describe, expect, test } from 'bun:test';
import { ClaudePlanRunner } from '../src/runner/claude-plan-runner.ts';
import { AgentError, ErrorCategory } from '../src/errors.ts';
import { AgentMode, type IAgentRunInput } from '../src/runner/types.ts';

function makeInput(overrides: Partial<IAgentRunInput> = {}): IAgentRunInput {
  return {
    mode: AgentMode.Plan,
    issue: {
      number: 1,
      title: 'Test issue',
      body: 'body',
      authorLogin: 'bence312',
    },
    context: { shrkTaskOutput: 'context' },
    limits: {
      maxInputTokens: 1000,
      maxOutputTokens: 100,
      deadlineMs: 5000,
    },
    signal: new AbortController().signal,
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ClaudePlanRunner', () => {
  test('returns markdown and telemetry on success', async () => {
    const fetchFn = (async () =>
      jsonResponse({
        content: [{ type: 'text', text: '## AI Plan\n\nbody' }],
        usage: { input_tokens: 50, output_tokens: 30 },
      })) as unknown as typeof fetch;

    const runner = new ClaudePlanRunner({
      apiKey: 'key',
      systemPrompt: 'system',
      userPromptTemplate: 'user {{ISSUE_TITLE}}',
      fetchFn,
    });

    const out = await runner.run(makeInput());
    expect(out.commentMarkdown).toContain('AI Plan');
    expect(out.telemetry.inputTokens).toBe(50);
    expect(out.telemetry.outputTokens).toBe(30);
    expect(out.telemetry.modelId).toBe('claude-opus-4-7');
  });

  test('substitutes placeholders in user prompt', async () => {
    let sentBody = '';
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      sentBody = init?.body ? String(init.body) : '';
      return jsonResponse({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as unknown as typeof fetch;

    const runner = new ClaudePlanRunner({
      apiKey: 'k',
      systemPrompt: 's',
      userPromptTemplate:
        '{{REPO_CONTEXT}} | {{ISSUE_NUMBER}} | {{ISSUE_AUTHOR}} | {{ISSUE_TITLE}} | {{ISSUE_BODY}}',
      fetchFn,
    });

    await runner.run(
      makeInput({
        issue: { number: 42, title: 'T', body: 'B', authorLogin: 'A' },
        context: { shrkTaskOutput: 'C' },
      }),
    );

    expect(sentBody).toContain('C | 42 | A | T | B');
  });

  test('throws RunnerTokenLimit when estimate exceeds cap', async () => {
    const fetchFn = (async () => jsonResponse({})) as unknown as typeof fetch;
    const runner = new ClaudePlanRunner({
      apiKey: 'k',
      systemPrompt: 'x'.repeat(5000),
      userPromptTemplate: 'x'.repeat(5000),
      fetchFn,
    });
    let caught: unknown;
    try {
      await runner.run(makeInput({ limits: { maxInputTokens: 100, maxOutputTokens: 100, deadlineMs: 1000 } }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AgentError);
    if (caught instanceof AgentError) {
      expect(caught.category).toBe(ErrorCategory.RunnerTokenLimit);
    }
  });

  test('maps AbortError to RunnerTimeout', async () => {
    const fetchFn = (async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }) as unknown as typeof fetch;
    const runner = new ClaudePlanRunner({
      apiKey: 'k',
      systemPrompt: 's',
      userPromptTemplate: 'u',
      fetchFn,
    });
    let caught: unknown;
    try {
      await runner.run(makeInput());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AgentError);
    if (caught instanceof AgentError) {
      expect(caught.category).toBe(ErrorCategory.RunnerTimeout);
    }
  });

  test('maps non-2xx response to RunnerApiError', async () => {
    const fetchFn = (async () =>
      new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
    const runner = new ClaudePlanRunner({
      apiKey: 'k',
      systemPrompt: 's',
      userPromptTemplate: 'u',
      fetchFn,
    });
    let caught: unknown;
    try {
      await runner.run(makeInput());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AgentError);
    if (caught instanceof AgentError) {
      expect(caught.category).toBe(ErrorCategory.RunnerApiError);
      expect(caught.message).toContain('429');
    }
  });

  test('maps empty content to RunnerApiError', async () => {
    const fetchFn = (async () =>
      jsonResponse({
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      })) as unknown as typeof fetch;
    const runner = new ClaudePlanRunner({
      apiKey: 'k',
      systemPrompt: 's',
      userPromptTemplate: 'u',
      fetchFn,
    });
    let caught: unknown;
    try {
      await runner.run(makeInput());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AgentError);
    if (caught instanceof AgentError) {
      expect(caught.category).toBe(ErrorCategory.RunnerApiError);
    }
  });
});
