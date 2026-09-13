import { splitIdentifierTokens } from '../split-identifier.ts';

/** Words that name no construct in a reuse intent ("I want to add a …"). */
const STOP: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'to', 'for', 'of', 'and', 'or', 'with', 'in', 'on', 'into', 'my',
  'add', 'use', 'using', 'create', 'make', 'new', 'build', 'want', 'need', 'how', 'do',
]);

/**
 * Minimum token length. 2-char tokens (`ui`, `id`) substring-match unrelated
 * text (`guidance`, `valid`) in the curated metadata fields, which are still
 * matched by containment.
 */
const MIN_TOKEN_LENGTH = 3;

/**
 * The distinct tokens a reuse lookup matches on — for the INTENT and for a
 * construct's NAME alike, so the two sides are normalised identically.
 *
 * Words are split by THE identifier tokenizer (`splitIdentifierTokens`), so
 * an intent typed as an identifier (`DateRangePicker`) and the same words
 * typed apart (`date range picker`) are the same query. Stop words and
 * fragments under {@link MIN_TOKEN_LENGTH} are dropped; order is kept.
 */
export function tokenizeReuseIntent(text: string): string[] {
  return [
    ...new Set(
      splitIdentifierTokens(text).filter((t) => t.length >= MIN_TOKEN_LENGTH && !STOP.has(t)),
    ),
  ];
}
