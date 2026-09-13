import { splitIdentifierTokens } from './split-identifier.ts';

/**
 * THE tokenizer for search-tuning TRIGGERS — the `tokens` a query/task yields
 * for `tuningBoostFor`, which a `taskHints[].whenTokens` entry must appear in.
 *
 * Five call sites used to tokenize for the same matcher five ways:
 *
 *   - `shrk search` and `search tuning explain`: split on whitespace and
 *     `, . ; : /` — keeps `changed-only`, `c#`, `foo_bar` whole;
 *   - the task ranker and the context re-ranker: split on `[^a-z0-9]` —
 *     `changed-only` became `changed`, `only`;
 *   - ranker explain: `[^a-z0-9]` AND dropped tokens shorter than 3 — `go`,
 *     `pr`, `ci` vanished.
 *
 * So a hyphenated trigger fired in `shrk search` and never in `shrk task` /
 * `shrk context`, and `shrk why` reported a tuning trace the rankers did not
 * apply. This returns the UNION: each whitespace/punctuation token whole, plus
 * its alphanumeric pieces (from THE identifier splitter), dropping tokens
 * shorter than 2. It is a superset of every former variant, so no trigger that
 * fired anywhere stops firing; one that fired in only one ranker now fires in
 * all of them. Order is first-seen; duplicates are dropped.
 */
export function tuningQueryTokens(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (token: string): void => {
    if (token.length < 2 || seen.has(token)) return;
    seen.add(token);
    out.push(token);
  };
  for (const raw of text.toLowerCase().split(/[\s,.;:/]+/)) {
    const token = raw.trim();
    add(token);
    // The input is already lowercase, so the splitter's camelCase rules are
    // inert here: this is exactly the old `[^a-z0-9]+` split, from the one
    // identifier tokenizer.
    for (const piece of splitIdentifierTokens(token)) add(piece);
  }
  return out;
}

/**
 * Can a query ever produce `whenToken`? A trigger with whitespace, a separator
 * (`, . ; : /`) or fewer than 2 characters never appears in
 * {@link tuningQueryTokens}' output, so its task hint can never apply.
 */
export function isReachableTuningTrigger(whenToken: string): boolean {
  const lower = whenToken.toLowerCase();
  return tuningQueryTokens(lower).includes(lower);
}
