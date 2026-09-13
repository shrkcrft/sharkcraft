/**
 * True when an authored entry is an OBJECT (a candidate marker) rather than a
 * plain unit — the parser's first fork. An array or `null` is not one: it is a
 * malformed entry, refused with its own message.
 */
export function isMarkerObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
