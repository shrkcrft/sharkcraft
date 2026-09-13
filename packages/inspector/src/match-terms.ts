/**
 * THE term matcher — the one answer to "does this trigger word appear in this
 * task?" for routing hints, playbooks, the recommender's built-in recipes, the
 * change-intent domain keywords and the ranker's distinct-term evidence.
 *
 * Every one of those used raw `task.toLowerCase().includes(needle)`, so a
 * two-letter keyword fired inside unrelated words (`ci` in `pricing`, `pr` in
 * `pricing`, `gate` in `investigate`, `pack` in `package`) and a hyphenated
 * tag could never match the same words typed with spaces (`capability-pack`
 * vs "capability pack").
 *
 * Terms come from THE identifier tokenizer (`split-identifier.ts`) over the
 * LOWERCASED text — so camelCase splitting is inert and both sides split the
 * same way on hyphens, underscores, whitespace and punctuation. Never write a
 * second tokenizer.
 */
import { TermMatchMode } from '@shrkcrft/plugin-api';
import { splitIdentifierTokens } from './split-identifier.ts';
import type { ITermQuery } from './term-query.ts';

/** Function words dropped by {@link contentTerms}. Small and fixed on purpose. */
export const TERM_STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'to',
  'for',
  'of',
  'in',
  'on',
  'and',
  'or',
  'with',
  'my',
  'our',
  'please',
  'i',
  'we',
  'it',
  'is',
]);

/**
 * Plain inflections one term may differ by. Agent-noun suffixes (`er`, `ers`)
 * are deliberately absent: `block` → `blocker`, `build` → `builder` change the
 * meaning, and `block` firing on "the blocker in billing" was one of the
 * reproduced false positives.
 */
const INFLECTION_SUFFIXES: readonly string[] = ['s', 'es', 'ed', 'ing'];

/** A term shorter than this matches only itself — `ci`, `pr`, `go` never inflect. */
const MIN_INFLECTABLE_LENGTH = 3;

/** Final consonants that double before `-ing` / `-ed` (`plan` → `planning`). */
const DOUBLING_CONSONANT = /[bdgklmnprtz]$/;

/** Lowercase, then split with THE identifier tokenizer. Order and duplicates are kept. */
export function normaliseTerms(text: string): string[] {
  return splitIdentifierTokens(text.toLowerCase());
}

/** {@link normaliseTerms} minus {@link TERM_STOPWORDS}, distinct, first-seen order. */
export function contentTerms(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of normaliseTerms(text)) {
    if (TERM_STOPWORDS.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** Prepare a task once for any number of {@link matchTerm} calls. */
export function prepareTermQuery(text: string): ITermQuery {
  return { lower: text.toLowerCase(), terms: normaliseTerms(text) };
}

function inflects(base: string, word: string): boolean {
  if (base.length < MIN_INFLECTABLE_LENGTH || word.length <= base.length) return false;
  for (const suffix of INFLECTION_SUFFIXES) if (word === base + suffix) return true;
  const last = base[base.length - 1]!;
  const stem = base.slice(0, -1);
  if (last === 'e' && (word === `${base}d` || word === `${stem}ing`)) return true;
  if (last === 'y' && (word === `${stem}ies` || word === `${stem}ied`)) return true;
  if (DOUBLING_CONSONANT.test(base) && (word === `${base}${last}ing` || word === `${base}${last}ed`)) return true;
  return false;
}

/** Two terms agree when equal, or one plain inflection apart (either direction). */
export function termsAgree(a: string, b: string): boolean {
  return a === b || inflects(a, b) || inflects(b, a);
}

/**
 * Does `needle` occur in the query?
 *
 * - {@link TermMatchMode.Tokens} (default): the needle's terms must appear
 *   contiguously in the query's terms, each agreeing ({@link termsAgree}). A
 *   needle with no terms (empty, or punctuation only) never matches.
 * - {@link TermMatchMode.Substring}: the legacy `lower.includes(needle)`,
 *   reproduced exactly (an empty needle matches everything — the routing-hint
 *   load lint errors on it).
 */
export function matchTerm(
  query: ITermQuery,
  needle: string,
  mode: TermMatchMode | `${TermMatchMode}` = TermMatchMode.Tokens,
): boolean {
  if ((mode as string) === TermMatchMode.Substring) return query.lower.includes(needle.toLowerCase());
  const seq = normaliseTerms(needle);
  if (seq.length === 0 || seq.length > query.terms.length) return false;
  for (let i = 0; i + seq.length <= query.terms.length; i++) {
    let all = true;
    for (let j = 0; j < seq.length; j++) {
      if (!termsAgree(seq[j]!, query.terms[i + j]!)) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return false;
}

/**
 * The DISTINCT `queryTerms` that agree with some term of `corpus` — the
 * evidence count "how many different words of the task does this item
 * mention?". Repeats inside the corpus never count twice.
 */
export function matchedQueryTerms(
  queryTerms: readonly string[],
  corpus: readonly (string | undefined)[],
): string[] {
  const corpusTerms = new Set<string>();
  for (const c of corpus) if (c) for (const t of normaliseTerms(c)) corpusTerms.add(t);
  const out: string[] = [];
  for (const q of queryTerms) {
    if (out.includes(q)) continue;
    for (const t of corpusTerms) {
      if (termsAgree(q, t)) {
        out.push(q);
        break;
      }
    }
  }
  return out;
}

/** Jaccard similarity of two term lists, as sets (0 when both are empty). */
export function termJaccard(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}
