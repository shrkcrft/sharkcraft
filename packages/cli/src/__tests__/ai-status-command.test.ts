import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { aiStatusCommand } from '../commands/ai-status.command.ts';
import { templatesLintCommand } from '../commands/template-quality.command.ts';
import type { ParsedArgs } from '../command-registry.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SHRK_DISABLE_AUTO_AI = '1';

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

const SAVED = {
  anthropicKey: process.env.ANTHROPIC_API_KEY,
  geminiKey: process.env.GEMINI_API_KEY,
};

beforeEach(() => {
  // Force "no hosted provider reachable" — routes through claude/gemini
  // with no API key, deterministically returning provider=null without
  // touching local llama.cpp env state baked into .env.
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

afterEach(() => {
  if (SAVED.anthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = SAVED.anthropicKey;
  if (SAVED.geminiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = SAVED.geminiKey;
});

describe('shrk ai-status', () => {
  test('--json --provider claude (no key) returns ai block with setup hints, exit=1', async () => {
    const { value, stdout } = await captureStdio(() =>
      aiStatusCommand.run(
        makeArgs([], [
          ['provider', 'claude'],
          ['json', true],
        ]),
      ),
    );
    expect(value).toBe(1);
    const parsed = JSON.parse(stdout) as { ai: { reachable: boolean; providerId: string | null; hints: unknown[] } };
    expect(parsed.ai.reachable).toBe(false);
    expect(parsed.ai.providerId).toBeNull();
    expect(parsed.ai.hints.length).toBeGreaterThan(0);
  });

  test('--json omits ping block when --ping was not requested', async () => {
    const { stdout } = await captureStdio(() =>
      aiStatusCommand.run(
        makeArgs([], [
          ['provider', 'claude'],
          ['json', true],
        ]),
      ),
    );
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed.ping).toBeUndefined();
  });

  test('--ping --provider claude (no key) returns failed ping with reason', async () => {
    const { stdout, value } = await captureStdio(() =>
      aiStatusCommand.run(
        makeArgs([], [
          ['provider', 'claude'],
          ['json', true],
          ['ping', true],
        ]),
      ),
    );
    expect(value).toBe(1);
    const parsed = JSON.parse(stdout) as { ping: { ok: boolean; reason?: string } };
    expect(parsed.ping.ok).toBe(false);
    expect(parsed.ping.reason).toContain('no provider reachable');
  });

  test('human output includes status line and AI hints block', async () => {
    const { stdout } = await captureStdio(() =>
      aiStatusCommand.run(
        makeArgs([], [['provider', 'claude']]),
      ),
    );
    expect(stdout).toContain('AI status');
    expect(stdout).toContain('reachable');
    expect(stdout).toContain('## AI configuration');
  });
});

describe('shrk templates lint --llm-recommendations', () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('without flag: JSON has no llmRecommendations field', async () => {
    root = mkFixture();
    const { stdout } = await captureStdio(() =>
      templatesLintCommand.run(
        makeArgs([], [
          ['cwd', root],
          ['json', true],
        ]),
      ),
    );
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed.llmRecommendations).toBeUndefined();
    expect(parsed.results).toBeDefined();
  });

  test('with flag + no provider reachable: llmRecommendations carries empty list + setup hints', async () => {
    root = mkFixture();
    const { stdout } = await captureStdio(() =>
      templatesLintCommand.run(
        makeArgs([], [
          ['cwd', root],
          ['json', true],
          ['llm-recommendations', true],
          ['provider', 'claude'],
        ]),
      ),
    );
    const parsed = JSON.parse(stdout) as { llmRecommendations: { ai: { reachable: boolean; hints: unknown[] }; recommendations: unknown[] } };
    expect(parsed.llmRecommendations).toBeDefined();
    expect(parsed.llmRecommendations.ai.reachable).toBe(false);
    expect(parsed.llmRecommendations.recommendations).toEqual([]);
    expect(parsed.llmRecommendations.ai.hints.length).toBeGreaterThan(0);
  });
});

function mkFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-lint-llm-test-'));
  const dir = join(root, 'sharkcraft');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'lint-llm-fixture', version: '0.0.0', type: 'module' }, null, 2),
  );
  writeFileSync(
    join(dir, 'templates.ts'),
    `export default [{
  id: 'demo.t',
  name: 'Demo',
  description: 'Demo template.',
  tags: ['demo'],
  scope: ['typescript'],
  appliesWhen: ['create-feature'],
  variables: [{ name: 'description', required: true, description: 'desc', examples: ['x'] }],
  targetPath: 'packages/x/y.ts',
  content: 'export const x = 1;',
}];
`,
  );
  writeFileSync(
    join(dir, 'sharkcraft.config.ts'),
    `export default {
  projectName: 'lint-llm-fixture',
  templateFiles: ['templates.ts'],
};\n`,
  );
  return root;
}
