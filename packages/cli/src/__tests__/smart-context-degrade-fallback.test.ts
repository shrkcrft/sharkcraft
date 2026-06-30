import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { smartContextCommand } from '../commands/smart-context.command.ts';
import type { ParsedArgs } from '../command-registry.ts';

// Keep the deterministic engine from trying to load the real embedding
// model when run against a fresh fixture (it would OOM Bun).
process.env.SHRK_DISABLE_AUTO_AI = '1';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_AI_PROVIDER = process.env.AI_PROVIDER;
const ORIGINAL_OLLAMA_HOST = process.env.OLLAMA_HOST;

const writeOut = process.stdout.write.bind(process.stdout);
const writeErr = process.stderr.write.bind(process.stderr);

async function captureStdio<T>(
  fn: () => T | Promise<T>,
): Promise<{ value: T; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  (process.stdout.write as unknown as (s: string) => boolean) = ((s: string) => {
    stdout += s;
    return true;
  }) as never;
  (process.stderr.write as unknown as (s: string) => boolean) = ((s: string) => {
    stderr += s;
    return true;
  }) as never;
  try {
    const value = await Promise.resolve(fn());
    return { value, stdout, stderr };
  } finally {
    process.stdout.write = writeOut as never;
    process.stderr.write = writeErr as never;
  }
}

function makeArgs(positional: string[], flags: Array<[string, string | boolean]>): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>(flags),
    multiFlags: new Map<string, string[]>(),
  };
}

beforeEach(() => {
  delete process.env.AI_PROVIDER;
  delete process.env.OLLAMA_HOST;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_AI_PROVIDER === undefined) delete process.env.AI_PROVIDER;
  else process.env.AI_PROVIDER = ORIGINAL_AI_PROVIDER;
  if (ORIGINAL_OLLAMA_HOST === undefined) delete process.env.OLLAMA_HOST;
  else process.env.OLLAMA_HOST = ORIGINAL_OLLAMA_HOST;
});

// Every chat call 500s, so each enhancement stage degrades after its single
// retry. With every stage degraded the pipeline's finalOutput is just the
// echoed system message (preamble + "## Repository context" + the assembled
// deterministic seed). The command must NOT leak that raw internal prompt to
// stdout — it must fall back to the clean deterministic seed, exactly like the
// single-shot provider-failure path.
function makeAlways500Fetch(counter: { calls: number }): typeof fetch {
  return (async (input: unknown) => {
    if (String(input).includes('/api/tags')) {
      return new Response(JSON.stringify({ models: [{ name: 'llama3.1' }] }), { status: 200 });
    }
    counter.calls += 1;
    return new Response('boom', { status: 500 });
  }) as unknown as typeof fetch;
}

describe('shrk smart-context — full enhancement degrade falls back to deterministic seed', () => {
  test('JSON: all stages degraded → clean renderSeed content, deterministic-fallback, no LLM wrapper', async () => {
    process.env.AI_PROVIDER = 'ollama';
    process.env.OLLAMA_HOST = 'http://localhost:11434';
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'shrk-degrade-json-'));
    try {
      writeFileSync(
        join(fixtureRoot, 'package.json'),
        JSON.stringify({ name: 'tmp', version: '0.0.0' }),
        'utf8',
      );
      const counter = { calls: 0 };
      globalThis.fetch = makeAlways500Fetch(counter);

      const { value, stdout } = await captureStdio(() =>
        smartContextCommand.run(
          makeArgs(['add', 'a', 'new', 'doctor', 'check'], [
            ['cwd', fixtureRoot],
            ['json', true],
            ['no-instructions', true],
          ]),
        ),
      );
      expect(value).toBe(0);
      const parsed = JSON.parse(stdout) as {
        mode: string;
        content: string;
        ai: { provider: string; model: string; finishReason: string | null };
        enhancement?: unknown;
      };
      expect(parsed.mode).toBe('brief');
      // The fallback mirrors the single-shot provider-failure path: clean
      // deterministic ai metadata, no enhancement telemetry.
      expect(parsed.ai.finishReason).toBe('deterministic-fallback');
      expect(parsed.ai.provider).toBe('deterministic');
      expect(parsed.ai.model).toBe('deterministic');
      expect(parsed.enhancement).toBeUndefined();
      // Clean deterministic seed — has the seed's own headers...
      expect(parsed.content).toContain('# Task');
      expect(parsed.content).toContain('add a new doctor check');
      // ...and NONE of the system-prompt preamble / LLM context wrapper that
      // the echoed raw prompt would have carried.
      expect(parsed.content).not.toContain('Use this context as authoritative ground truth');
      expect(parsed.content).not.toContain('## Repository context');
      expect(parsed.content).not.toContain('STRICT GROUNDING');
      // Fast path = draft + polish, each retried once before degrading = 4 calls.
      expect(counter.calls).toBe(4);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('non-JSON: stdout carries the clean seed (no wrapper) and stderr notes the degrade', async () => {
    process.env.AI_PROVIDER = 'ollama';
    process.env.OLLAMA_HOST = 'http://localhost:11434';
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'shrk-degrade-text-'));
    try {
      writeFileSync(
        join(fixtureRoot, 'package.json'),
        JSON.stringify({ name: 'tmp', version: '0.0.0' }),
        'utf8',
      );
      const counter = { calls: 0 };
      globalThis.fetch = makeAlways500Fetch(counter);

      const { value, stdout, stderr } = await captureStdio(() =>
        smartContextCommand.run(
          makeArgs(['add', 'a', 'new', 'doctor', 'check'], [
            ['cwd', fixtureRoot],
            ['no-instructions', true],
          ]),
        ),
      );
      expect(value).toBe(0);
      // No raw internal prompt on stdout.
      expect(stdout).not.toContain('Use this context as authoritative ground truth');
      expect(stdout).not.toContain('## Repository context');
      expect(stdout).not.toContain('STRICT GROUNDING');
      // The deterministic seed body is what reaches stdout.
      expect(stdout).toContain('# Task');
      // The degrade is advisory on stderr only.
      expect(stderr).toContain('enhancement fully degraded');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
