import { resolve } from 'node:path';
import { ClaudePlanRunner } from './claude-plan-runner.ts';
import type { IAgentRunner } from './types.ts';

const PROMPTS_DIR = resolve(import.meta.dir, '../prompts');

export async function createRunner(): Promise<IAgentRunner> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }

  const [systemPrompt, userPromptTemplate] = await Promise.all([
    Bun.file(resolve(PROMPTS_DIR, 'system.md')).text(),
    Bun.file(resolve(PROMPTS_DIR, 'plan.md')).text(),
  ]);

  return new ClaudePlanRunner({
    apiKey,
    systemPrompt,
    userPromptTemplate,
  });
}
