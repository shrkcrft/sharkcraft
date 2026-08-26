import type { IWiringSource } from './wiring-rule.ts';

/**
 * Resolution of `$use` references against a config's named `extractors` map.
 *
 * Three planes routinely describe the SAME id set — a wiring rule's `declared`,
 * a registry's `source`, and a baseline's `compute.source` all pointing at one
 * glob+pattern. Written out three times they drift: a directory move updated in
 * two of the three leaves the planes silently disagreeing about which set they
 * are talking about, and every one of them still reports a confident pass. A
 * named extractor makes that impossible by construction — one definition, N
 * consumers, no copy to fall out of date.
 *
 * The resolver lives in `core` because every layer above needs the identical
 * answer: the config loader (so a typo'd id fails at load with a field path),
 * the pack-plane merge seam (so a pack element referencing an id this repo does
 * not define is dropped with a diagnostic instead of matching nothing), and the
 * engines (which must never see an unresolved reference).
 */

/** A config's named extractor definitions, keyed by the id `$use` names. */
export type ExtractorMap = Readonly<Record<string, IWiringSource>>;

/** The resolved source, or the reason the reference could not be resolved. */
export interface IResolvedSource {
  readonly source: IWiringSource;
  /** Set when `$use` names an extractor that does not exist. */
  readonly error?: string;
}

/**
 * Resolve one source's `$use` reference, if it has one.
 *
 * Local fields WIN over the named extractor's: `{ $use: 'handlers', match:
 * '^Legacy' }` reuses the shared file/extract selection but narrows the match,
 * so sharing never forces an all-or-nothing reuse. `$use` itself survives
 * resolution as provenance, which is what lets `gates explain` say a consumer
 * resolved from `handlers` rather than presenting an anonymous inline selector.
 *
 * A source with no `$use` is returned untouched — inline selectors keep working
 * exactly as before, so this is purely opt-in.
 */
export function resolveExtractorRef(
  source: IWiringSource,
  extractors: ExtractorMap | undefined,
): IResolvedSource {
  const ref = source.$use;
  if (ref === undefined) return { source };

  const base = extractors?.[ref];
  if (!base) {
    const known = Object.keys(extractors ?? {}).sort();
    return {
      source,
      error:
        `references unknown extractor "${ref}" — declared extractors: ` +
        `${known.length > 0 ? known.join(', ') : '(none)'}`,
    };
  }

  // Spread base first so every explicitly-set local field overrides it. An
  // `undefined` local value must NOT clobber the base, so drop those keys.
  const overrides: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === '$use' || value === undefined) continue;
    overrides[key] = value;
  }
  return { source: { ...base, ...overrides, $use: ref } as IWiringSource };
}

/**
 * Every distinct extractor id referenced by the given sources, in first-seen
 * order. Used to report a shared extractor ONCE in the coverage view and to
 * name its consumers.
 */
export function referencedExtractorIds(
  sources: ReadonlyArray<IWiringSource | undefined>,
): string[] {
  const seen: string[] = [];
  for (const source of sources) {
    const ref = source?.$use;
    if (ref !== undefined && !seen.includes(ref)) seen.push(ref);
  }
  return seen;
}
