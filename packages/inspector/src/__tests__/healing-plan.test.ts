import { describe, expect, it } from 'bun:test';
import {
  HEALING_PLAN_SCHEMA,
  buildHealingPlanFromCommand,
  buildHealingPlanFromError,
} from '../index.ts';

describe('healing plan', () => {
  it('classifies unknown command diagnostic', () => {
    const p = buildHealingPlanFromError('Unknown command: foo');
    expect(p.schema).toBe(HEALING_PLAN_SCHEMA);
    expect(p.detectedDiagnostics.find((d) => d.code === 'unknown-command')).toBeDefined();
    expect(p.recommendedCommands.length).toBeGreaterThan(0);
  });

  it('classifies missing module diagnostic', () => {
    const p = buildHealingPlanFromError('Cannot find module @shrkcrft/foo');
    expect(p.detectedDiagnostics.find((d) => d.code === 'missing-node-modules')).toBeDefined();
    expect(p.recommendedCommands.join(' ')).toContain('bun install');
  });

  it('classifies plan conflict via keywords', () => {
    const p = buildHealingPlanFromError('Plan conflict: anchor not found in barrel file');
    expect(p.likelyCauses.join(' ').toLowerCase()).toContain('conflict');
    expect(p.recommendedCommands.join(' ')).toContain('shrk plan simulate');
  });

  it('signing missing secret marks human approval', () => {
    const p = buildHealingPlanFromError(
      'pack signing failed: signature mismatch — SHARKCRAFT_PACK_SIGNING_KEY missing',
    );
    expect(p.humanApprovalRequired).toBe(true);
    expect(p.recommendedCommands.join(' ')).toContain('shrk packs sign');
  });

  it('generic fallback emits a triage command', () => {
    const p = buildHealingPlanFromError('something unhelpful here');
    expect(p.recommendedCommands.length).toBeGreaterThan(0);
    expect(p.forbiddenQuickFixes.length).toBeGreaterThan(0);
  });

  it('from-command marks the failed verification diagnostic', () => {
    const p = buildHealingPlanFromCommand('bun test', 1, 'tests failed');
    expect(p.detectedDiagnostics.find((d) => d.code === 'failed-verification')).toBeDefined();
  });
});
