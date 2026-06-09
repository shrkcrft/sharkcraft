import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ERROR_CODES } from '@shrkcrft/core';
import { OllamaProvider } from '../ollama/ollama-provider.ts';
import { AiMessageRole } from '../ai-request.ts';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_HOST = process.env.OLLAMA_HOST;
const ORIGINAL_PORT = process.env.OLLAMA_PORT;
const ORIGINAL_MODEL = process.env.OLLAMA_MODEL;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_HOST === undefined) delete process.env.OLLAMA_HOST;
  else process.env.OLLAMA_HOST = ORIGINAL_HOST;
  if (ORIGINAL_PORT === undefined) delete process.env.OLLAMA_PORT;
  else process.env.OLLAMA_PORT = ORIGINAL_PORT;
  if (ORIGINAL_MODEL === undefined) delete process.env.OLLAMA_MODEL;
  else process.env.OLLAMA_MODEL = ORIGINAL_MODEL;
});

describe('OllamaProvider — readiness gate', () => {
  test('isReady() is true even without env vars (localhost default)', () => {
    delete process.env.OLLAMA_HOST;
    const provider = new OllamaProvider();
    expect(provider.isReady()).toBe(true);
  });
});

describe('OllamaProvider — request shaping (mocked fetch)', () => {
  beforeEach(() => {
    delete process.env.OLLAMA_HOST;
    delete process.env.OLLAMA_MODEL;
  });

  test('uses OLLAMA_HOST + OLLAMA_MODEL from env and maps roles', async () => {
    process.env.OLLAMA_HOST = 'http://gpu-box:11434';
    process.env.OLLAMA_MODEL = 'qwen2.5-coder';
    let capturedUrl = '';
    let capturedBody: unknown = null;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(
        JSON.stringify({
          model: 'qwen2.5-coder',
          message: { role: 'assistant', content: 'pong' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 12,
          eval_count: 4,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const provider = new OllamaProvider();
    const result = await provider.send({
      messages: [
        { role: AiMessageRole.System, content: 'rules' },
        { role: AiMessageRole.User, content: 'ping' },
        { role: AiMessageRole.Assistant, content: 'hi' },
      ],
      maxTokens: 128,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toBe('pong');
    expect(result.value.model).toBe('qwen2.5-coder');
    expect(result.value.finishReason).toBe('stop');
    expect(result.value.usage?.inputTokens).toBe(12);
    expect(result.value.usage?.outputTokens).toBe(4);

    expect(capturedUrl).toBe('http://gpu-box:11434/api/chat');
    const body = capturedBody as {
      model: string;
      stream: boolean;
      messages: Array<{ role: string; content: string }>;
      options: { num_predict: number };
      format?: unknown;
    };
    expect(body.model).toBe('qwen2.5-coder');
    expect(body.stream).toBe(false);
    expect(body.options.num_predict).toBe(128);
    expect(body.messages).toEqual([
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'ping' },
      { role: 'assistant', content: 'hi' },
    ]);
    expect(body.format).toBeUndefined();
  });

  test('falls back to localhost:11434 and the llama3.1 default model', async () => {
    let capturedUrl = '';
    let capturedBody: unknown = null;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(
        JSON.stringify({ message: { role: 'assistant', content: 'ok' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const provider = new OllamaProvider();
    const result = await provider.send({
      messages: [{ role: AiMessageRole.User, content: 'hi' }],
    });

    expect(result.ok).toBe(true);
    expect(capturedUrl).toBe('http://localhost:11434/api/chat');
    expect((capturedBody as { model: string }).model).toBe('llama3.1');
  });

  test('configure({ baseUrl, model }) overrides env', async () => {
    process.env.OLLAMA_HOST = 'http://from-env:11434';
    process.env.OLLAMA_MODEL = 'env-model';
    let capturedUrl = '';
    let capturedBody: unknown = null;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(
        JSON.stringify({ message: { role: 'assistant', content: 'ok' } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const provider = new OllamaProvider();
    provider.configure({ baseUrl: 'http://configured:11434/', model: 'configured-model' });
    const result = await provider.send({
      messages: [{ role: AiMessageRole.User, content: 'hi' }],
    });

    expect(result.ok).toBe(true);
    expect(capturedUrl).toBe('http://configured:11434/api/chat');
    expect((capturedBody as { model: string }).model).toBe('configured-model');
  });

  test('json_schema response format becomes Ollama structured-output `format` field', async () => {
    let capturedBody: unknown = null;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(
        JSON.stringify({ message: { role: 'assistant', content: '{"ok":true}' } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const schema = {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
    };
    const provider = new OllamaProvider();
    const result = await provider.send({
      messages: [{ role: AiMessageRole.User, content: 'return json' }],
      responseFormat: { type: 'json_schema', schemaName: 'test', schema },
    });

    expect(result.ok).toBe(true);
    const body = capturedBody as { format?: unknown };
    expect(body.format).toEqual(schema);
  });

  test('json_object response format collapses to format: "json"', async () => {
    let capturedBody: unknown = null;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(
        JSON.stringify({ message: { role: 'assistant', content: '{}' } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const provider = new OllamaProvider();
    const result = await provider.send({
      messages: [{ role: AiMessageRole.User, content: 'return json' }],
      responseFormat: { type: 'json_object' },
    });

    expect(result.ok).toBe(true);
    expect((capturedBody as { format?: unknown }).format).toBe('json');
  });

  test('non-2xx response surfaces as IO_ERROR with status', async () => {
    globalThis.fetch = (async () =>
      new Response('model not found', { status: 404 })) as unknown as typeof fetch;
    const provider = new OllamaProvider();
    const result = await provider.send({
      messages: [{ role: AiMessageRole.User, content: 'x' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('404');
      expect(result.error.message).toContain('model not found');
    }
  });

  test('split OLLAMA_HOST + OLLAMA_PORT assemble into http://<host>:<port>', async () => {
    process.env.OLLAMA_HOST = 'gpu-box';
    process.env.OLLAMA_PORT = '12345';
    let capturedUrl = '';
    globalThis.fetch = (async (input: unknown) => {
      capturedUrl = String(input);
      return new Response(
        JSON.stringify({ message: { role: 'assistant', content: 'ok' } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const provider = new OllamaProvider();
    const result = await provider.send({ messages: [{ role: AiMessageRole.User, content: 'x' }] });
    expect(result.ok).toBe(true);
    expect(capturedUrl).toBe('http://gpu-box:12345/api/chat');
  });

  test('bare OLLAMA_HOST without OLLAMA_PORT defaults the port to 11434', async () => {
    process.env.OLLAMA_HOST = 'gpu-box';
    delete process.env.OLLAMA_PORT;
    let capturedUrl = '';
    globalThis.fetch = (async (input: unknown) => {
      capturedUrl = String(input);
      return new Response(
        JSON.stringify({ message: { role: 'assistant', content: 'ok' } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const provider = new OllamaProvider();
    const result = await provider.send({ messages: [{ role: AiMessageRole.User, content: 'x' }] });
    expect(result.ok).toBe(true);
    expect(capturedUrl).toBe('http://gpu-box:11434/api/chat');
  });

  test('OLLAMA_HOST as full URL takes precedence — OLLAMA_PORT is ignored', async () => {
    process.env.OLLAMA_HOST = 'http://configured:9999';
    process.env.OLLAMA_PORT = '7777';
    let capturedUrl = '';
    globalThis.fetch = (async (input: unknown) => {
      capturedUrl = String(input);
      return new Response(
        JSON.stringify({ message: { role: 'assistant', content: 'ok' } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const provider = new OllamaProvider();
    const result = await provider.send({ messages: [{ role: AiMessageRole.User, content: 'x' }] });
    expect(result.ok).toBe(true);
    expect(capturedUrl).toBe('http://configured:9999/api/chat');
  });

  test('only OLLAMA_PORT set → host defaults to localhost', async () => {
    delete process.env.OLLAMA_HOST;
    process.env.OLLAMA_PORT = '22222';
    let capturedUrl = '';
    globalThis.fetch = (async (input: unknown) => {
      capturedUrl = String(input);
      return new Response(
        JSON.stringify({ message: { role: 'assistant', content: 'ok' } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const provider = new OllamaProvider();
    const result = await provider.send({ messages: [{ role: AiMessageRole.User, content: 'x' }] });
    expect(result.ok).toBe(true);
    expect(capturedUrl).toBe('http://localhost:22222/api/chat');
  });

  test('per-call timeoutMs aborts a slow call and returns a TIMEOUT error', async () => {
    // fetch never resolves on its own; it rejects only when the provider's
    // timeout fires and aborts the signal it passed in.
    globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          );
        }
      })) as unknown as typeof fetch;
    const provider = new OllamaProvider();
    const result = await provider.send({
      messages: [{ role: AiMessageRole.User, content: 'x' }],
      timeoutMs: 10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ERROR_CODES.TIMEOUT);
      expect(result.error.message).toContain('10ms');
    }
  });

  test('passes an AbortSignal to fetch only when a timeout is set', async () => {
    let sawSignal = false;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      sawSignal = init?.signal !== undefined;
      return new Response(
        JSON.stringify({ message: { role: 'assistant', content: 'ok' } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const provider = new OllamaProvider();
    const noTimeout = await provider.send({ messages: [{ role: AiMessageRole.User, content: 'x' }] });
    expect(noTimeout.ok).toBe(true);
    expect(sawSignal).toBe(false);
    const withTimeout = await provider.send({
      messages: [{ role: AiMessageRole.User, content: 'x' }],
      timeoutMs: 5000,
    });
    expect(withTimeout.ok).toBe(true);
    expect(sawSignal).toBe(true);
  });

  test('network error includes host in the message', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    process.env.OLLAMA_HOST = 'http://unreachable:11434';
    const provider = new OllamaProvider();
    const result = await provider.send({
      messages: [{ role: AiMessageRole.User, content: 'x' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('http://unreachable:11434');
      expect(result.error.message).toContain('ECONNREFUSED');
    }
  });
});
