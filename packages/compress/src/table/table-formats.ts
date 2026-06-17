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

/**
 * Parse a whole CSV document into records of fields, honouring `"`-quoted
 * fields with `""` escapes — including fields that contain commas, `\r`/`\n`,
 * or the record separator itself. Splitting the document into lines BEFORE
 * honouring quotes (the old approach) shattered any quoted field that carried
 * a newline (e.g. a column name containing `\n`), so the inverse threw or
 * dropped data. Record separators are unquoted `\n`, `\r\n`, or `\r`.
 */
function parseCsvRecords(csv: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let pending = false; // the current record has started (content or a separator seen)
  const endField = (): void => {
    row.push(field);
    field = '';
    pending = true;
  };
  const endRecord = (): void => {
    endField();
    records.push(row);
    row = [];
    pending = false;
  };
  for (let i = 0; i < csv.length; i += 1) {
    const ch = csv[i];
    if (inQuotes) {
      if (ch === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
      pending = true;
    } else if (ch === '"') {
      inQuotes = true;
      pending = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\n') {
      endRecord();
    } else if (ch === '\r') {
      endRecord();
      if (csv[i + 1] === '\n') i += 1;
    } else {
      field += ch;
      pending = true;
    }
  }
  // Flush a trailing record unless the document ended exactly on a record
  // separator (nothing pending), matching `out.join('\n')` having no trailer.
  if (pending || field.length > 0 || row.length > 0) endRecord();
  return records;
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
  const records = parseCsvRecords(csv);
  if (records.length === 0) return [];
  const header = records[0] ?? [];
  const out: Row[] = [];
  for (let r = 1; r < records.length; r += 1) {
    const fields = records[r] ?? [];
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

/**
 * A column name is safe to write bare in a `key: value` line only when it can't
 * collide with the `: ` separator or the line/record structure. Otherwise we
 * JSON-encode it (a leading `"` is the decoder's signal) so the key survives the
 * round trip — `markdownKvToObjects` splits on the FIRST `: `, which a key
 * containing `: ` or a newline would otherwise break.
 */
function markdownKeyNeedsQuoting(key: string): boolean {
  return key.includes(': ') || key.includes('\n') || key.includes('\r') || key.startsWith('"');
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
      const rawKey = String(cols[c]);
      const keyText = markdownKeyNeedsQuoting(rawKey) ? JSON.stringify(rawKey) : rawKey;
      present.push(`${keyText}: ${JSON.stringify(cellValue(table, r, c))}`);
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
    let key: string;
    let value: string;
    if (line.startsWith('"')) {
      // JSON-encoded key (emitted by markdownKeyNeedsQuoting): read the JSON
      // string token, then the `: ` separator, then the JSON value.
      const end = jsonStringEnd(line);
      if (end < 0) continue;
      const rest = line.slice(end);
      if (!rest.startsWith(': ')) continue;
      try {
        key = JSON.parse(line.slice(0, end)) as string;
      } catch {
        continue;
      }
      value = rest.slice(2);
    } else {
      const sep = line.indexOf(': ');
      if (sep < 0) continue;
      key = line.slice(0, sep);
      value = line.slice(sep + 2);
    }
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

/**
 * Given a string whose char 0 is `"`, return the index just past the matching
 * closing quote of that JSON string token (honouring `\"` escapes), or -1 if
 * unterminated.
 */
function jsonStringEnd(s: string): number {
  for (let i = 1; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '"') return i + 1;
  }
  return -1;
}
