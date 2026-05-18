import { describe, expect, test } from 'bun:test';
import { normalizeEmail } from '../src/utils/format-email.ts';

describe('normalizeEmail', () => {
  test('lowercases and trims', () => {
    expect(normalizeEmail('  Alice@Example.COM ')).toBe('alice@example.com');
  });
});
