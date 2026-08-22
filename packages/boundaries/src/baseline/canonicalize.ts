/**
 * Canonicalization for baseline comparison.
 *
 * The point is NOT prettiness — it is that a reordering, a re-indent, or a
 * key shuffle must not read as drift. A noisy diff trains reviewers to bless
 * without reading, which is how a real deletion ships inside a "formatting"
 * update.
 */

/** The canonical forms a baseline rule may request. */
export type CanonicalForm = 'auto' | 'json-sorted-keys' | 'lines-sorted' | 'lines' | 'raw';

/** The form actually applied, plus the canonical text. */
export interface ICanonicalResult {
  readonly text: string;
  /** The concrete form used (`auto` is resolved to one of the others). */
  readonly form: Exclude<CanonicalForm, 'auto'>;
}

/** Parse `text` as JSON, or `undefined` when it is not JSON. */
export function tryParseJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const first = trimmed[0];
  if (first !== '{' && first !== '[' && first !== '"') return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** Recursively sort object keys so key ORDER is never mistaken for a change. */
export function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      out[k] = sortJsonKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

function normalizeLines(text: string, sorted: boolean): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+$/, ''))
    .filter((l) => l.trim() !== '');
  if (sorted) lines.sort();
  return lines.join('\n');
}

/**
 * Bring both sides of a comparison into the same form.
 *
 * `auto` resolves to `json-sorted-keys` only when BOTH sides parse as JSON —
 * a pure function of the two inputs, so the same pair always canonicalizes the
 * same way (a per-side sniff would make the result depend on which file was
 * malformed).
 */
export function canonicalizePair(
  expected: string,
  actual: string,
  form: CanonicalForm = 'auto',
): { expected: ICanonicalResult; actual: ICanonicalResult } {
  let resolved: Exclude<CanonicalForm, 'auto'>;
  if (form === 'auto') {
    const bothJson = tryParseJson(expected) !== undefined && tryParseJson(actual) !== undefined;
    resolved = bothJson ? 'json-sorted-keys' : 'lines';
  } else {
    resolved = form;
  }
  const one = (text: string): ICanonicalResult => ({
    text: canonicalizeOne(text, resolved),
    form: resolved,
  });
  return { expected: one(expected), actual: one(actual) };
}

/** Apply one concrete canonical form. Falls back to `lines` when JSON won't parse. */
export function canonicalizeOne(text: string, form: Exclude<CanonicalForm, 'auto'>): string {
  switch (form) {
    case 'json-sorted-keys': {
      const parsed = tryParseJson(text);
      if (parsed === undefined) return normalizeLines(text, false);
      return JSON.stringify(sortJsonKeys(parsed), null, 2);
    }
    case 'lines-sorted':
      return normalizeLines(text, true);
    case 'lines':
      return normalizeLines(text, false);
    case 'raw':
      return text.replace(/\r\n/g, '\n').replace(/\n+$/, '');
    default:
      return text;
  }
}
