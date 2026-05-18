import { describe, expect, test } from 'bun:test';
import { DemoScenario, validateDemoPackage } from '../index.ts';

describe('r16 demo package validate', () => {
  test('built-in scenarios validate cleanly', () => {
    const report = validateDemoPackage({ scope: DemoScenario.PrReview });
    expect(report.ok).toBe(true);
    expect(report.scenariosChecked).toContain(DemoScenario.PrReview);
    expect(report.commandsFound.length).toBeGreaterThan(0);
  });
  test('catalog filter flags unknown commands when provided', () => {
    const report = validateDemoPackage({
      scope: DemoScenario.PrReview,
      knownCommands: ['shrk doctor'], // intentionally narrow
    });
    expect(report.findings.some((f) => f.code === 'unknown-shrk-command')).toBe(true);
  });
});
