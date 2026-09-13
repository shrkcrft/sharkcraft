/**
 * How a refusal names the value it refused — `(got an array)`, `(got false)`,
 * `(got "src/**")` — in the marker parser's messages. Strings are quoted and
 * truncated, so one long value cannot swamp the line.
 */
export function describeEntryValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}…` : value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (typeof value === 'function') return 'a function';
  return 'an object';
}
