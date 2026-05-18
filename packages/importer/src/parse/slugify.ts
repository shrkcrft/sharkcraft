export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'of',
  'in',
  'on',
  'to',
  'for',
  'with',
  'is',
  'are',
  'be',
  'as',
  'at',
  'by',
  'from',
  'this',
  'that',
  'should',
  'must',
  'do',
  'not',
  'never',
  'always',
  'use',
  'when',
  'if',
]);

/** Pull 2–4 keyword-like tokens from a string for tag inference. */
export function keywordTags(input: string): string[] {
  const tokens = input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
  const out: string[] = [];
  for (const t of tokens) {
    if (!out.includes(t)) out.push(t);
    if (out.length === 4) break;
  }
  return out;
}
