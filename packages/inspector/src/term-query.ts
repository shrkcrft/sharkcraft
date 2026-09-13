/**
 * A task/query prepared once for {@link matchTerm}: its lowercase text (for
 * the legacy substring mode) and its normalised term sequence (for tokens
 * mode). Build it with `prepareTermQuery`; never hand-assemble one.
 */
export interface ITermQuery {
  readonly lower: string;
  readonly terms: readonly string[];
}
