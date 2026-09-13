/**
 * What an injected resolver says about one cross-reference id, for rendering.
 *
 * The knowledge package sits below the inspector, which owns the reference
 * registry, so `formatEntryFull` cannot resolve ids itself — the caller injects
 * a resolver built from the registry and the formatter only renders its answer.
 */
export interface IKnowledgeRefResolution {
  /** Every kind whose registry lists the id, most specific first. Empty = resolves nowhere. */
  readonly kinds: readonly string[];
  /** The target's title, when the registry that holds it has one. */
  readonly title?: string;
  /** True when the lookup could not be made (registries not warmed) — NOT VERIFIED, never "unresolved". */
  readonly unverified?: boolean;
}
