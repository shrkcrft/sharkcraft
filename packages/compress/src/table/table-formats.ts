import type { IColumnarTable } from './columnar-table.ts';

/**
 * Alternative, model-read-friendly encodings of a columnar table (P4.2). The
 * default wire shape is the columnar JSON envelope; these offer the same data
 * as CSV or Markdown key/value blocks for shapes where a flat layout reads more
 * accurately. Both are reversible: their inverse rebuilds the original object
 * array exactly (cell values are JSON-encoded, so strings, numbers, booleans,
 * null, and nested values all round-trip; an absent key stays absent).
 *
 * Whether any of these becomes a default awaits the P4.1 comprehension eval —
 * until then they are opt-in. Pure and deterministic.
 */

type Row = Record<string, unknown>;

function csvEscapeField(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Parse one CSV line into fields, honouring `"`-quoted fields with `""` escapes. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else cur += ch;
  }
  fields.push(cur);
  return fields;
}

/**
 * Resolve a cell to its REAL value, dereferencing a dict index when the column
 * is value-dictionary encoded. CSV/MD-KV are read-accuracy text formats, so they
 * must show the value, not the index.
 */
function cellValue(table: IColumnarTable, r: number, c: number): unknown {
  const { cols, rows, dict } = table._table;
  const raw = rows[r]?.[c];
  const name = cols[c];
  return dict && name !== undefined && Object.prototype.hasOwnProperty.call(dict, name)
    ? dict[name]![raw as number]
    : raw;
}

/** Encode a columnar table as CSV: a header row of column names, then one row per record. */
export function columnarToCsv(table: IColumnarTable): string {
  const { cols, rows, absent } = table._table;
  const w = cols.length;
  const absentSet = new Set(absent.map(([r, c]) => r * w + c));
  const out = [cols.map(csvEscapeField).join(',')];
  for (let r = 0; r < rows.length; r += 1) {
    const cells = cols.map((_, c) =>
      // Absent → a truly empty field; present → JSON-encoded value (always
      // quoted by the escaper when it would otherwise be ambiguous).
      absentSet.has(r * w + c) ? '' : csvEscapeField(JSON.stringify(cellValue(table, r, c))),
    );
    out.push(cells.join(','));
  }
  return out.join('\n');
}

/** Inverse of {@link columnarToCsv}: rebuild the original object array. */
export function csvToObjects(csv: string): Row[] {
  // Tolerate CRLF: split on \r?\n so a trailing \r never contaminates a column
  // name or value (Windows / network-transferred CSV).
  const lines = csv.split(/\r?\n/);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0] ?? '');
  const out: Row[] = [];
  for (let r = 1; r < lines.length; r += 1) {
    const fields = parseCsvLine(lines[r] ?? '');
    // A present value is always JSON-encoded (non-empty: even "" becomes `""`),
    // so a truly empty parsed field unambiguously means the key was absent.
    const obj: Row = {};
    for (let c = 0; c < header.length; c += 1) {
      const name = header[c];
      if (name === undefined) continue;
      const field = fields[c];
      if (field === undefined || field === '') continue; // absent key
      Object.defineProperty(obj, name, {
        value: JSON.parse(field),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    out.push(obj);
  }
  return out;
}

/** Encode a columnar table as Markdown key/value blocks, one block per record. */
export function columnarToMarkdownKv(table: IColumnarTable): string {
  const { cols, rows, absent } = table._table;
  const w = cols.length;
  const absentSet = new Set(absent.map(([r, c]) => r * w + c));
  const blocks: string[] = [];
  for (let r = 0; r < rows.length; r += 1) {
    const present: string[] = [];
    for (let c = 0; c < w; c += 1) {
      if (absentSet.has(r * w + c)) continue;
      present.push(`${cols[c]}: ${JSON.stringify(cellValue(table, r, c))}`);
    }
    // `- ` opens a record; remaining keys are indented two spaces.
    const lines = present.map((line, idx) => (idx === 0 ? `- ${line}` : `  ${line}`));
    blocks.push(lines.length > 0 ? lines.join('\n') : '-');
  }
  return blocks.join('\n');
}

/** Inverse of {@link columnarToMarkdownKv}: rebuild the original object array. */
export function markdownKvToObjects(md: string): Row[] {
  const out: Row[] = [];
  let cur: Row | null = null;
  const commit = (): void => {
    if (cur) out.push(cur);
  };
  for (const rawLine of md.split(/\r?\n/)) {
    const opensRecord = rawLine.startsWith('- ');
    const line = opensRecord ? rawLine.slice(2) : rawLine.replace(/^\s+/, '');
    if (opensRecord) {
      commit();
      cur = {};
    }
    if (rawLine === '-') {
      commit();
      cur = {};
      continue;
    }
    if (!cur) continue;
    const sep = line.indexOf(': ');
    if (sep < 0) continue;
    const key = line.slice(0, sep);
    const value = line.slice(sep + 2);
    Object.defineProperty(cur, key, {
      value: JSON.parse(value),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  commit();
  return out;
}
