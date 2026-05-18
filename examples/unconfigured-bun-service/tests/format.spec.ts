import { describe, expect, test } from 'bun:test';
import { formatCents } from '../src/utils/format.util.ts';

describe('formatCents', () => {
  test('formats positive amounts with two decimals', () => {
    expect(formatCents(1234)).toBe('$12.34');
  });
  test('pads minor digits', () => {
    expect(formatCents(105)).toBe('$1.05');
  });
  test('handles negative amounts', () => {
    expect(formatCents(-99)).toBe('-$0.99');
  });
});
