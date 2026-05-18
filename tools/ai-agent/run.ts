#!/usr/bin/env bun
import { orchestrate } from './src/orchestrate.ts';
import type { IIssueEvent } from './src/gate.ts';

async function main(): Promise<void> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    console.error('[ai-agent] GITHUB_EVENT_PATH is not set');
    process.exit(2);
  }

  let event: IIssueEvent;
  try {
    event = (await Bun.file(eventPath).json()) as IIssueEvent;
  } catch (err) {
    console.error('[ai-agent] failed to parse event JSON', err);
    process.exit(2);
  }

  const result = await orchestrate(event);
  switch (result.kind) {
    case 'success':
      process.exit(0);
    case 'ignored':
      console.log(`[ai-agent] ignored: ${result.reason}`);
      process.exit(0);
    case 'failure':
      console.error(`[ai-agent] failed: ${result.category} — ${result.message}`);
      process.exit(1);
  }
}

await main();
