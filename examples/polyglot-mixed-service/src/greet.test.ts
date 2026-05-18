import { describe, expect, it } from 'bun:test';
import { hello } from './greet.ts';

describe('hello', () => {
  it('includes the name', () => {
    expect(hello('world')).toBe('Hello, world!');
  });
});
