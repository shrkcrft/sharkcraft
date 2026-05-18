import { describe, expect, test } from 'bun:test';
import { buildPrimaryCommandsReport, buildStartHereReport, renderPrimaryCommandsText, renderStartHereText } from '../index.ts';

describe('r16 start-here', () => {
  test('default report contains 5 primary flows + 2 optional', () => {
    const r = buildStartHereReport();
    expect(r.primaryFlows.length).toBeGreaterThanOrEqual(5);
    expect(r.optionalFlows.length).toBeGreaterThanOrEqual(2);
    expect(r.recommendedFirstCommand).toBeTruthy();
    const txt = renderStartHereText(r);
    expect(txt).toContain('start here');
    expect(txt).toContain('Safety pledge');
  });
  test('filtering by flow returns just that one', () => {
    const r = buildStartHereReport('onboard');
    expect(r.primaryFlows.length).toBe(1);
    expect(r.primaryFlows[0]!.id).toBe('onboard');
  });
  test('primary commands report is non-empty', () => {
    const r = buildPrimaryCommandsReport();
    expect(r.primary.length).toBeGreaterThanOrEqual(8);
    expect(renderPrimaryCommandsText(r)).toContain('shrk');
  });
});
