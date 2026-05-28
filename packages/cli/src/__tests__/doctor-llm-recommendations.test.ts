import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctorCommand } from '../commands/doctor.command.ts';
import { templatesDriftCommand } from '../commands/templates.command.ts';
import type { ParsedArgs } from '../command-registry.ts';

process.env.SHRK_DISABLE_AUTO_AI = '1';

const SAVED = {
  anthropicKey: process.env.ANTHROPIC_API_KEY,
};

beforeEach(() => {
  // Force "no provider reachable" deterministically by routing through
  // `claude` with no API key — both Bun's auto .env loading and the
  // local-first auto chain are sidestepped without depending on env
  // mutations sticking through dynamic dispatch.
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  if (SAVED.anthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = SAVED.anthropicKey;
});

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

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-doctor-llm-test-'));
  const dir = join(root, 'sharkcraft');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'doctor-llm-fixture', version: '0.0.0', type: 'module' }, null, 2),
  );
  writeFileSync(
    join(dir, 'templates.ts'),
    `export default [{
  id: 'demo.t',
  name: 'Demo',
  description: 'Has a warning-class issue.',
  tags: ['demo'],
  scope: ['typescript'],
  appliesWhen: ['create-feature'],
  variables: [],
  targetPath: 'packages/x/y.ts',
  content: 'export const x = {{undeclared}};',
}];
`,
  );
  writeFileSync(
    join(dir, 'sharkcraft.config.ts'),
    `export default {
  projectName: 'doctor-llm-fixture',
  templateFiles: ['templates.ts'],
};\n`,
  );
  return root;
}

describe('doctor --llm-recommendations', () => {
  test('without flag: output contains no llmRecommendations field', async () => {
    const root = makeFixture();
    try {
      const { stdout } = await captureStdio(() =>
        doctorCommand.run(makeArgs([], [['cwd', root], ['json', true]])),
      );
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      expect(parsed.llmRecommendations).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('with flag + no LLM reachable: llmRecommendations carries empty list + ai setup hints', async () => {
    const root = makeFixture();
    try {
      const { stdout } = await captureStdio(() =>
        doctorCommand.run(makeArgs([], [['cwd', root], ['json', true], ['llm-recommendations', true], ['provider', 'claude']])),
      );
      const parsed = JSON.parse(stdout) as { llmRecommendations?: { ai: { reachable: boolean; hints: unknown[] }; recommendations: unknown[] } };
      expect(parsed.llmRecommendations).toBeDefined();
      expect(parsed.llmRecommendations!.recommendations).toEqual([]);
      expect(parsed.llmRecommendations!.ai.reachable).toBe(false);
      expect(parsed.llmRecommendations!.ai.hints.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('templates drift --llm-recommendations', () => {
  test('without flag: deterministic JSON has no llmRecommendations field', async () => {
    const root = makeFixture();
    try {
      const { stdout } = await captureStdio(() =>
        templatesDriftCommand.run(makeArgs([], [['cwd', root], ['json', true]])),
      );
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      expect(parsed.llmRecommendations).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('with flag + no LLM: llmRecommendations carries empty list + ai setup hints', async () => {
    const root = makeFixture();
    try {
      const { stdout } = await captureStdio(() =>
        templatesDriftCommand.run(makeArgs([], [['cwd', root], ['json', true], ['llm-recommendations', true], ['provider', 'claude']])),
      );
      const parsed = JSON.parse(stdout) as { llmRecommendations?: { ai: { reachable: boolean }; recommendations: unknown[] } };
      expect(parsed.llmRecommendations).toBeDefined();
      expect(parsed.llmRecommendations!.recommendations).toEqual([]);
      expect(parsed.llmRecommendations!.ai.reachable).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
