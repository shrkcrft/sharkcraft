/**
 * A small, pure BM25 relevance scorer for query-biased compression. Plain
 * token-overlap counting ({@link queryOverlap}) is weak: it can't tell a term
 * that appears in every row from a rare, discriminating one, and it under-
 * weights single-term and ID/UUID exact matches. BM25 weights each query term
 * by inverse document frequency and normalizes for row/line length, so a
 * uniquely-relevant row outranks a row that merely repeats a common word.
 *
 * Deterministic: a pure function of (query, documents). No clock, no RNG, no
 * learned state. When the query is empty every score is 0, so callers fall
 * straight back to their no-query behaviour.
 */

export interface IBm25Options {
  /** Term-frequency saturation. Default 1.2. */
  k1?: number;
  /** Length-normalization strength. Default 0.75. */
  b?: number;
}

/** Extra idf weight for an exact ID-shaped term (UUID / long hex / email). */
const ID_BOOST = 2.5;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^(?:0x)?[0-9a-f]{8,}$/i;
const EMAIL_RE = /^[\w.+-]+@[\w-]+\.[\w.-]+$/;

interface IQueryTerm {
  term: string;
  /** ID-shaped terms match by exact substring (the tokenizer would split them). */
  id: boolean;
}

function isIdShaped(term: string): boolean {
  return UUID_RE.test(term) || HEX_RE.test(term) || EMAIL_RE.test(term);
}

/** Parse a query into terms, preserving ID-shaped chunks (UUIDs, emails) whole. */
function parseQueryTerms(query: string): IQueryTerm[] {
  const seen = new Set<string>();
  const out: IQueryTerm[] = [];
  for (const chunk of query.trim().split(/\s+/)) {
    if (chunk.length === 0) continue;
    if (isIdShaped(chunk)) {
      const t = chunk.toLowerCase();
      if (!seen.has(t)) {
        seen.add(t);
        out.push({ term: t, id: true });
      }
      continue;
    }
    for (const sub of chunk.toLowerCase().split(/[^a-z0-9]+/)) {
      if (sub.length < 1 || seen.has(sub)) continue;
      seen.add(sub);
      out.push({ term: sub, id: false });
    }
  }
  return out;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

/** BM25 score per document for `query`. Empty query → all zeros. */
export function bm25Scores(
  query: string,
  documents: readonly string[],
  opts: IBm25Options = {},
): number[] {
  const n = documents.length;
  if (n === 0) return [];
  const terms = parseQueryTerms(query);
  if (terms.length === 0) return documents.map(() => 0);

  const k1 = opts.k1 ?? 1.2;
  const b = opts.b ?? 0.75;
  // Lowercase each document ONCE, then derive tokens from the lowercased form
  // (was lowercased twice: in the tokenizer and again for ID substring matching).
  const docLower = documents.map((d) => d.toLowerCase());
  const docTokens = docLower.map((l) => l.split(/[^a-z0-9]+/).filter((t) => t.length > 0));
  const dl = docTokens.map((t) => t.length);
  const avgdl = dl.reduce((s, x) => s + x, 0) / n || 1;

  const scores = new Array<number>(n).fill(0);
  // One reusable frequency buffer for all terms — every slot is overwritten each
  // term below, so no per-term allocation (or reset) is needed.
  const f = new Array<number>(n).fill(0);
  for (const { term, id } of terms) {
    let df = 0;
    for (let d = 0; d < n; d += 1) {
      const count = id
        ? countOccurrences(docLower[d]!, term)
        : docTokens[d]!.reduce((s, t) => s + (t === term ? 1 : 0), 0);
      f[d] = count;
      if (count > 0) df += 1;
    }
    if (df === 0) continue;
    let idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    if (id) idf *= ID_BOOST;
    for (let d = 0; d < n; d += 1) {
      if (f[d]! === 0) continue;
      const denom = f[d]! + k1 * (1 - b + (b * dl[d]!) / avgdl);
      scores[d]! += (idf * (f[d]! * (k1 + 1))) / denom;
    }
  }
  return scores;
}

/**
 * Indices of the top-`k` documents by BM25 score (score > 0 only), highest
 * first, ties broken by ascending index for determinism. Empty query → `[]`.
 */
export function topByBm25(
  query: string,
  documents: readonly string[],
  k: number,
  opts: IBm25Options = {},
): number[] {
  const scores = bm25Scores(query, documents, opts);
  return scores
    .map((score, index) => ({ score, index }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, k))
    .map((x) => x.index);
}
