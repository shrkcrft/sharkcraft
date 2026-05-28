import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlamaCppProvider } from '../llamacpp/llama-cpp-provider.ts';
import { AiMessageRole } from '../ai-request.ts';

const ORIGINAL_PATH = process.env.LLAMACPP_MODEL_PATH;

afterEach(() => {
  if (ORIGINAL_PATH === undefined) delete process.env.LLAMACPP_MODEL_PATH;
  else process.env.LLAMACPP_MODEL_PATH = ORIGINAL_PATH;
  LlamaCppProvider._overrideForTests = null;
});

describe('LlamaCppProvider — readiness gate', () => {
  test('isReady() is false when no model path is configured', () => {
    delete process.env.LLAMACPP_MODEL_PATH;
    const provider = new LlamaCppProvider();
    expect(provider.isReady()).toBe(false);
  });

  test('isReady() is false when the configured path does not exist', () => {
    process.env.LLAMACPP_MODEL_PATH = '/definitely/not/a/file.gguf';
    const provider = new LlamaCppProvider();
    expect(provider.isReady()).toBe(false);
  });

  test('isReady() is true when LLAMACPP_MODEL_PATH points to an existing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shrk-llama-'));
    try {
      const modelPath = join(dir, 'fake.gguf');
      writeFileSync(modelPath, '');
      process.env.LLAMACPP_MODEL_PATH = modelPath;
      const provider = new LlamaCppProvider();
      expect(provider.isReady()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('send() returns INVALID_INPUT when no model is configured', async () => {
    delete process.env.LLAMACPP_MODEL_PATH;
    const provider = new LlamaCppProvider();
    const result = await provider.send({
      messages: [{ role: AiMessageRole.User, content: 'hello' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('LLAMACPP_MODEL_PATH');
    }
  });
});

describe('LlamaCppProvider — request shaping (via _overrideForTests)', () => {
  let dir = '';
  let modelPath = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shrk-llama-'));
    modelPath = join(dir, 'fake.gguf');
    writeFileSync(modelPath, '');
    process.env.LLAMACPP_MODEL_PATH = modelPath;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('forwards messages + maxTokens to the override; returns a parsed response', async () => {
    let received: {
      messages: ReadonlyArray<{ role: string; content: string }>;
      maxTokens?: number;
      modelPath: string;
    } | null = null;
    LlamaCppProvider._overrideForTests = async (request, mp) => {
      received = {
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
        modelPath: mp,
      };
      return {
        content: 'ack',
        model: 'fake.gguf',
        finishReason: 'stop',
        usage: { inputTokens: 5, outputTokens: 1 },
      };
    };

    const provider = new LlamaCppProvider();
    const result = await provider.send({
      messages: [
        { role: AiMessageRole.System, content: 'You are a planner.' },
        { role: AiMessageRole.User, content: 'plan something' },
      ],
      maxTokens: 256,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toBe('ack');
    expect(result.value.model).toBe('fake.gguf');
    expect(received).not.toBeNull();
    expect(received!.messages).toEqual([
      { role: 'system', content: 'You are a planner.' },
      { role: 'user', content: 'plan something' },
    ]);
    expect(received!.maxTokens).toBe(256);
    expect(received!.modelPath).toBe(modelPath);
  });

  test('override errors bubble up as IO_ERROR', async () => {
    LlamaCppProvider._overrideForTests = async () => {
      throw new Error('boom');
    };
    const provider = new LlamaCppProvider();
    const result = await provider.send({
      messages: [{ role: AiMessageRole.User, content: 'hi' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('boom');
    }
  });
});
