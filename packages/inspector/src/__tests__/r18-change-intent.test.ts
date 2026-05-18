import { describe, expect, test } from 'bun:test';
import {
  ChangeIntentConfidence,
  ChangeIntentKind,
  classifyChangeIntent,
  inspectSharkcraft,
} from '../index.ts';

describe('r18 change intent', () => {
  test('classifies a feature task', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const intent = await classifyChangeIntent('add a new MCP tool for compliance check', inspection);
    expect(intent.schema).toBe('sharkcraft.change-intent/v1');
    expect(intent.kind).toBe(ChangeIntentKind.Feature);
    expect(intent.domains).toContain('mcp');
    expect(intent.suggestedFirstCommand).toContain('brief');
  });
  test('classifies a bugfix task', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const intent = await classifyChangeIntent('fix the broken release readiness gate', inspection);
    expect(intent.kind).toBe(ChangeIntentKind.Bugfix);
    expect(intent.suggestedFirstCommand).toContain('impact');
  });
  test('classifies an architecture task as requiring human review', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const intent = await classifyChangeIntent('refactor the package boundary layer order', inspection);
    expect([ChangeIntentKind.Architecture, ChangeIntentKind.Refactor]).toContain(intent.kind);
    expect(intent.requiredHumanReview).toBe(true);
  });
  test('classifies a release task and warns about not auto-publishing', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const intent = await classifyChangeIntent('tag the public alpha release and publish to npm', inspection);
    expect(intent.kind).toBe(ChangeIntentKind.Release);
    expect(intent.requiredHumanReview).toBe(true);
    expect(intent.riskHints.some((r) => /publish/i.test(r))).toBe(true);
  });
  test('empty task returns low-confidence unknown', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const intent = await classifyChangeIntent('', inspection);
    expect(intent.kind).toBe(ChangeIntentKind.Unknown);
    expect(intent.confidence).toBe(ChangeIntentConfidence.Low);
  });
});
