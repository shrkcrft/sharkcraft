import type { ISubverbSpec } from './subverb-spec.ts';

/**
 * How far a handler's declarations explain an invocation's positionals: the
 * walk descends through each positional that names a declared subverb (at any
 * nesting depth) and stops at the first one that does not.
 */
export interface IDeclaredInvocation {
  /** The trie path plus every declared subverb the positionals named (`search tuning explain`). */
  readonly path: readonly string[];
  /** The declaration the walk stopped at: the handler itself, or the deepest matched subverb. */
  readonly level: Pick<ISubverbSpec, 'subverbs' | 'positionals' | 'flags' | 'usage'>;
  /** How many positionals named declared subverbs; `positional[consumed]` is the first that did not. */
  readonly consumed: number;
  /** The union of every flag set declared along the walk; absent when none was declared. */
  readonly flags?: ReadonlySet<string>;
}
