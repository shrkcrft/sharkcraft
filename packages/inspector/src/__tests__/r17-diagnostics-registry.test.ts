import { describe, expect, test } from 'bun:test';
import {
  buildDiagnosticByCode,
  getDiagnosticEntry,
  listDiagnostics,
} from '../index.ts';

describe('r17 diagnostics registry', () => {
  test('lists all known codes', () => {
    const entries = listDiagnostics();
    expect(entries.length).toBeGreaterThanOrEqual(10);
    const codes = entries.map((e) => e.code);
    expect(codes).toContain('missing-sharkcraft-config');
    expect(codes).toContain('mcp-cache-miss');
    expect(codes).toContain('plan-signature-mismatch');
  });
  test('getDiagnosticEntry returns the entry', () => {
    const e = getDiagnosticEntry('mcp-cache-miss');
    expect(e).not.toBeNull();
    expect(e!.contextKeys).toContain('briefId');
  });
  test('buildDiagnosticByCode honours context', () => {
    const d = buildDiagnosticByCode('mcp-cache-miss', { briefId: 'abc' });
    expect(d.problem).toContain('abc');
  });
  test('buildDiagnosticByCode falls back gracefully on missing context', () => {
    const d = buildDiagnosticByCode('plan-signature-mismatch');
    expect(d.problem).toContain('unknown');
  });
});
