/** Split into lines, tolerant of CRLF, without inventing a trailing line. */
export function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n');
}

/**
 * A normalization key for near-duplicate detection: lowercased, with numbers,
 * hex blobs and quoted paths collapsed to placeholders and whitespace
 * squeezed. Two log/warning lines that differ only in a counter or address
 * share a key, so repeated noise dedupes to one representative.
 */
export function dedupeKey(line: string): string {
  return line
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, '<x>')
    .replace(/\b[0-9a-f]{8,}\b/g, '<x>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokenize a query into lowercase words worth matching (length ≥ 2). */
export function queryTokens(query: string | undefined): string[] {
  if (!query) return [];
  const seen = new Set<string>();
  for (const raw of query.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length >= 2) seen.add(raw);
  }
  return [...seen];
}

/** How many query tokens appear in `text` (case-insensitive substring). */
export function queryOverlap(text: string, tokens: readonly string[]): number {
  if (tokens.length === 0) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const t of tokens) if (lower.includes(t)) hits += 1;
  return hits;
}

/**
 * Collapse a set of kept line indices into an elided block: kept lines verbatim,
 * each dropped run replaced by a single `… N line(s) omitted …` placeholder.
 * Deterministic and order-preserving.
 */
export function elide(lines: readonly string[], keep: ReadonlySet<number>): string {
  const out: string[] = [];
  let dropped = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (keep.has(i)) {
      if (dropped > 0) {
        out.push(`… ${dropped} line${dropped === 1 ? '' : 's'} omitted`);
        dropped = 0;
      }
      out.push(lines[i] ?? '');
    } else {
      dropped += 1;
    }
  }
  if (dropped > 0) out.push(`… ${dropped} line${dropped === 1 ? '' : 's'} omitted`);
  return out.join('\n');
}
