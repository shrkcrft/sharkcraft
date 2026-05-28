import { afterEach, describe, expect, test } from 'bun:test';
import { selectAiProvider } from '../provider-resolver.ts';

const ORIGINAL_AI_PROVIDER = process.env.AI_PROVIDER;
const ORIGINAL_GEMINI = process.env.GEMINI_API_KEY;
const ORIGINAL_CLAUDE = process.env.ANTHROPIC_API_KEY;
const ORIGINAL_LLAMACPP_PATH = process.env.LLAMACPP_MODEL_PATH;
const ORIGINAL_OLLAMA_HOST = process.env.OLLAMA_HOST;

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  restore('AI_PROVIDER', ORIGINAL_AI_PROVIDER);
  restore('GEMINI_API_KEY', ORIGINAL_GEMINI);
  restore('ANTHROPIC_API_KEY', ORIGINAL_CLAUDE);
  restore('LLAMACPP_MODEL_PATH', ORIGINAL_LLAMACPP_PATH);
  restore('OLLAMA_HOST', ORIGINAL_OLLAMA_HOST);
});

describe('selectAiProvider', () => {
  test('explicit "ollama" returns the OllamaProvider regardless of env', () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const result = selectAiProvider('ollama');
    expect(result.requested).toBe('ollama');
    expect(result.provider?.id).toBe('ollama');
  });

  test('explicit "gemini" returns null when GEMINI_API_KEY is missing', () => {
    delete process.env.GEMINI_API_KEY;
    const result = selectAiProvider('gemini');
    expect(result.requested).toBe('gemini');
    expect(result.provider).toBeNull();
  });

  test('AI_PROVIDER=ollama is honoured when no kind is passed', () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.AI_PROVIDER = 'ollama';
    const result = selectAiProvider();
    expect(result.provider?.id).toBe('ollama');
  });

  test('auto NEVER picks gemini even when GEMINI_API_KEY is set', () => {
    // The whole point of the local-first chain: a Gemini key sitting
    // in env should not pull the CLI onto a hosted API by surprise.
    process.env.GEMINI_API_KEY = 'test-key';
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.AI_PROVIDER;
    delete process.env.LLAMACPP_MODEL_PATH;
    const result = selectAiProvider('auto');
    expect(result.provider?.id).not.toBe('gemini');
    // Falls back to ollama (always "ready" structurally) when no
    // llamacpp model path is set.
    expect(result.provider?.id).toBe('ollama');
  });

  test('auto picks llamacpp when LLAMACPP_MODEL_PATH points at a real file', () => {
    const { mkdtempSync, rmSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
    const { tmpdir } = require('node:os') as typeof import('node:os');
    const { join } = require('node:path') as typeof import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'shrk-resolver-llama-'));
    const modelPath = join(dir, 'fake.gguf');
    writeFileSync(modelPath, '');
    process.env.LLAMACPP_MODEL_PATH = modelPath;
    delete process.env.AI_PROVIDER;
    try {
      const result = selectAiProvider('auto');
      expect(result.provider?.id).toBe('llamacpp');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('auto falls back to ollama when llamacpp is not ready', () => {
    // Ollama is always ready (its readiness check is just structural;
    // network reachability is deferred to send()). So with llamacpp
    // unavailable, the auto chain picks ollama next.
    delete process.env.LLAMACPP_MODEL_PATH;
    delete process.env.AI_PROVIDER;
    const result = selectAiProvider('auto');
    expect(result.provider?.id).toBe('ollama');
  });

  test('explicit "llamacpp" returns null when LLAMACPP_MODEL_PATH is unset', () => {
    delete process.env.LLAMACPP_MODEL_PATH;
    const result = selectAiProvider('llamacpp');
    expect(result.requested).toBe('llamacpp');
    expect(result.provider).toBeNull();
  });

  test('AI_PROVIDER=llamacpp is honoured when no kind is passed', () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.AI_PROVIDER = 'llamacpp';
    // No model path → not ready, but the resolver still recognised the kind.
    delete process.env.LLAMACPP_MODEL_PATH;
    const result = selectAiProvider();
    expect(result.requested).toBe('llamacpp');
    expect(result.provider).toBeNull();
  });

  test('unknown kind collapses to auto + AI_PROVIDER env hint', () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.AI_PROVIDER = 'ollama';
    const result = selectAiProvider('something-weird');
    expect(result.provider?.id).toBe('ollama');
  });
});
