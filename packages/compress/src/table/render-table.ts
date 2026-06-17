import type { ITableCompaction } from './table-compaction.ts';

const CELL_DELIM = '|';

function escapeCell(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '\\n');
}

// Column names are arbitrary object keys (anything after JSON.parse), so the
// header must escape the same chars as a cell PLUS the `,` separator and the
// trailing-`?` nullable marker — otherwise a key like `a,b` or `a\n` or `a?`
// would shatter or misrepresent the schema line.
function escapeHeaderName(name: string): string {
  return escapeCell(name).replace(/,/g, '\\,').replace(/\?/g, '\\?');
}

function renderCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return escapeCell(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return escapeCell(JSON.stringify(value) ?? '');
}

/**
 * Render a compacted table as a dense, model-readable text block. The header
 * lifts the schema once (`name?` marks a nullable column); rows are
 * pipe-delimited values with the delimiter / newlines / backslashes escaped.
 * This is the densest representation — used by `shrk compress` and the
 * `compress_context` tool, where the consumer reads text rather than parsing
 * JSON. For a parseable form, use {@link tableToColumnar}.
 */
export function renderTable(table: ITableCompaction): string {
  const head = `⟦table n=${table.originalCount} c=${table.cols.length}⟧`;
  const schema = table.cols
    .map((c) => (c.nullable ? `${escapeHeaderName(c.name)}?` : escapeHeaderName(c.name)))
    .join(',');
  const lines = table.rows.map((row) =>
    table.cols.map((_, c) => renderCell(row[c])).join(CELL_DELIM),
  );
  return [head, schema, ...lines].join('\n');
}
