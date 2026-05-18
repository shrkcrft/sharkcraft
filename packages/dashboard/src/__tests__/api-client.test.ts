import { describe, expect, test } from 'bun:test';
import { buildUrl, DashboardApiError } from '../api/client.ts';

// jsdom-free: stub window for buildUrl which only reads origin.
(globalThis as { window?: { location: { origin: string } } }).window = {
  location: { origin: 'http://127.0.0.1:4567' },
};

describe('api client', () => {
  test('buildUrl produces api paths with encoded params', () => {
    const out = buildUrl('/api/graph/why', { from: 'rule:a', to: 'template:b' });
    expect(out.startsWith('/api/graph/why?')).toBe(true);
    expect(out).toContain('from=rule%3Aa');
    expect(out).toContain('to=template%3Ab');
  });

  test('buildUrl drops undefined params', () => {
    const out = buildUrl('/api/sessions', { id: undefined, filter: 'open' });
    expect(out).toContain('filter=open');
    expect(out).not.toContain('id=');
  });

  test('DashboardApiError carries status and code', () => {
    const e = new DashboardApiError(404, 'not-found', 'not here');
    expect(e.status).toBe(404);
    expect(e.code).toBe('not-found');
    expect(e.message).toBe('not here');
    expect(e.name).toBe('DashboardApiError');
  });
});
