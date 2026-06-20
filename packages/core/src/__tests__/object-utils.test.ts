import { describe, expect, test } from 'bun:test';
import { merge, omit, pick } from '../index.ts';

// `{ __proto__: ... }` as a JS literal sets the prototype; to get a REAL own
// "__proto__" data property — what JSON.parse produces off the wire — parse a
// hand-written JSON string.
describe('object-utils — own-property safety (no prototype-chain leak / pollution)', () => {
  test('merge preserves a literal "__proto__" key as own data; no global pollution', () => {
    const b = JSON.parse('{"__proto__":{"x":1},"safe":2}') as Record<string, unknown>;
    const result = merge<Record<string, unknown>, Record<string, unknown>>({}, b);
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')!.value).toEqual({ x: 1 });
    expect(result.safe).toBe(2);
    // The global prototype must be untouched.
    expect((({} as Record<string, unknown>).x)).toBeUndefined();
  });

  test('merge deep-merges plain objects without reading inherited members', () => {
    const result = merge({ a: { p: 1 } }, { a: { q: 2 }, b: 3 });
    expect(result).toEqual({ a: { p: 1, q: 2 }, b: 3 });
  });

  test('pick copies only OWN properties (never the inherited toString)', () => {
    const obj: Record<string, unknown> = { a: 1 };
    const picked = pick(obj, ['a', 'toString']);
    expect(picked).toEqual({ a: 1 });
    expect(Object.prototype.hasOwnProperty.call(picked, 'toString')).toBe(false);
  });

  test('omit keeps remaining own data, including a literal "__proto__", without pollution', () => {
    const obj = JSON.parse('{"__proto__":{"x":1},"a":1,"b":2}') as Record<string, unknown>;
    const result = omit(obj, ['a']);
    expect((result as Record<string, unknown>).a).toBeUndefined();
    expect((result as Record<string, unknown>).b).toBe(2);
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(true);
  });
});
