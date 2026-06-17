import { compactObjectArray } from '../table/compact-object-array.ts';
import { renderTable } from '../table/render-table.ts';

/**
 * Render a JSON value as the densest deterministic text. A homogeneous object
 * array becomes a table block when that's shorter than minified JSON;
 * everything else is minified JSON (whitespace stripped, structure intact).
 * Lossless in information, though a table block is not itself re-parseable as
 * JSON — use this only where the consumer reads text (the `compress` surface),
 * not where a client calls `JSON.parse`.
 */
export function renderCompactJson(value: unknown): string {
  const minified = JSON.stringify(value) ?? 'null';
  const table = compactObjectArray(value);
  if (!table) return minified;
  const text = renderTable(table);
  return text.length < minified.length ? text : minified;
}
