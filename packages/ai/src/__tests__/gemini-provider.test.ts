import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { GeminiProvider } from '../gemini/gemini-provider.ts';
import { AiMessageRole } from '../ai-request.ts';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_KEY = process.env.GEMINI_API_KEY;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_KEY === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = ORIGINAL_KEY;
});

describe('GeminiProvider — readiness gate', () => {
  test('isReady() is false when neither config.apiKey nor GEMINI_API_KEY is set', () => {
    delete process.env.GEMINI_API_KEY;
    const provider = new GeminiProvider();
    expect(provider.isReady()).toBe(false);
  });

  test('isReady() picks up env var', () => {
    process.env.GEMINI_API_KEY = 'env-key';
    const provider = new GeminiProvider();
    expect(provider.isReady()).toBe(true);
  });

  test('configure({ apiKey }) wins over missing env', () => {
    delete process.env.GEMINI_API_KEY;
    const provider = new GeminiProvider();
    provider.configure({ apiKey: 'cfg-key' });
    expect(provider.isReady()).toBe(true);
  });

  test('send() returns an INVALID_INPUT error when the key is missing', async () => {
    delete process.env.GEMINI_API_KEY;
    const provider = new GeminiProvider();
    const result = await provider.send({
      messages: [{ role: AiMessageRole.User, content: 'hi' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('GEMINI_API_KEY');
    }
  });
});

describe('GeminiProvider — request shaping (mocked fetch)', () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-key';
  });

  test('translates system + user messages into Gemini wire format', async () => {
    let capturedUrl = '';
    let capturedBody: unknown = null;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: 'hello back' }] },
              finishReason: 'STOP',
            },
          ],
          modelVersion: 'gemini-2.5-flash',
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const provider = new GeminiProvider();
    const result = await provider.send({
      messages: [
        { role: AiMessageRole.System, content: 'system rules' },
        { role: AiMessageRole.User, content: 'do the thing' },
        { role: AiMessageRole.Assistant, content: 'ok' },
      ],
      maxTokens: 256,
      model: 'gemini-2.5-flash',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toBe('hello back');
    expect(result.value.model).toBe('gemini-2.5-flash');
    expect(result.value.finishReason).toBe('STOP');
    expect(result.value.usage?.inputTokens).toBe(10);
    expect(result.value.usage?.outputTokens).toBe(5);

    expect(capturedUrl).toContain('/v1beta/models/gemini-2.5-flash:generateContent');
    expect(capturedUrl).toContain('key=test-key');
    const body = capturedBody as {
      contents: Array<{ role: string; parts: Array<{ text: string }> }>;
      systemInstruction?: { parts: Array<{ text: string }> };
      generationConfig: { maxOutputTokens: number };
    };
    expect(body.generationConfig.maxOutputTokens).toBe(256);
    expect(body.systemInstruction?.parts[0]?.text).toBe('system rules');
    // System message must NOT appear in `contents` — only user/model turns.
    expect(body.contents.length).toBe(2);
    expect(body.contents[0]?.role).toBe('user');
    expect(body.contents[0]?.parts[0]?.text).toBe('do the thing');
    expect(body.contents[1]?.role).toBe('model');
    expect(body.contents[1]?.parts[0]?.text).toBe('ok');
  });

  test('adds JSON response hints when a response format is requested', async () => {
    let capturedBody: unknown = null;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }],
          modelVersion: 'gemini-2.5-flash',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const provider = new GeminiProvider();
    const result = await provider.send({
      messages: [{ role: AiMessageRole.User, content: 'return json' }],
      responseFormat: {
        type: 'json_schema',
        schemaName: 'test_schema',
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
      },
    });

    expect(result.ok).toBe(true);
    const body = capturedBody as {
      generationConfig: { responseMimeType?: string; responseSchema?: unknown };
    };
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema).toBeUndefined();
  });

  test('non-2xx response surfaces as IO_ERROR with status', async () => {
    globalThis.fetch = (async () =>
      new Response('quota exceeded', { status: 429 })) as unknown as typeof fetch;
    const provider = new GeminiProvider();
    const result = await provider.send({
      messages: [{ role: AiMessageRole.User, content: 'x' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('429');
      expect(result.error.message).toContain('quota exceeded');
    }
  });
});
