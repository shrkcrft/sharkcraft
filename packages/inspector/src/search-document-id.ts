/**
 * THE search-document id codec: `<prefix>:<id>`.
 *
 * Every search document is keyed `<prefix>:<id>` (`knowledge:auth.login`,
 * `rule:no-foo`, `facet:<construct>:<facet>`), and search tuning matches a
 * boost key against that WHOLE id (`boostIds[doc.id]`). The format used to be
 * hand-written at fourteen sites in the index builder, three in the task ranker
 * and one in the context re-ranker, while the self-config doctor looked the
 * whole key up in BARE-id registries. The two readings disagreed exactly: a
 * correctly prefixed key (which fires) was reported "unknown", and a bare key
 * (which can never fire) passed. One codec, read by every writer and every
 * reader, so they cannot disagree again.
 *
 * Split on the FIRST `:` — facet ids themselves contain a `:`.
 */
import type { ReferenceKind } from './reference-registry.ts';
import type { SearchDocumentPrefix } from './search-document-prefix.ts';

interface IPrefixSpec {
  /** The id registry the right-hand id lives in; `null` = no id registry. */
  readonly referenceKind: ReferenceKind | null;
  /** The `SearchKind` value the prefix's documents carry (what `appliesToKinds` compares). */
  readonly searchKind: string;
}

/**
 * One row per prefix. `Record<SearchDocumentPrefix, …>` makes a prefix added
 * to the type without a row here a compile error.
 */
const PREFIXES: Readonly<Record<SearchDocumentPrefix, IPrefixSpec>> = Object.freeze({
  knowledge: { referenceKind: 'knowledge', searchKind: 'knowledge' },
  rule: { referenceKind: 'rule', searchKind: 'rule' },
  path: { referenceKind: 'path-convention', searchKind: 'path' },
  template: { referenceKind: 'template', searchKind: 'template' },
  pipeline: { referenceKind: 'pipeline', searchKind: 'pipeline' },
  boundary: { referenceKind: 'boundary-rule', searchKind: 'boundary' },
  construct: { referenceKind: 'construct', searchKind: 'construct' },
  playbook: { referenceKind: 'playbook', searchKind: 'playbook' },
  // No id registry: presets, packs, bundles, sessions, construct facets and
  // docs are indexed, but nothing answers "does this id exist?" for them, so a
  // key naming one is UNVERIFIED — never "missing".
  preset: { referenceKind: null, searchKind: 'preset' },
  pack: { referenceKind: null, searchKind: 'pack' },
  bundle: { referenceKind: null, searchKind: 'bundle' },
  session: { referenceKind: null, searchKind: 'session' },
  facet: { referenceKind: null, searchKind: 'construct-facet' },
  doc: { referenceKind: null, searchKind: 'doc' },
});

/** Every search-document prefix, in declaration order. */
export const SEARCH_DOCUMENT_PREFIXES: readonly SearchDocumentPrefix[] = Object.freeze(
  Object.keys(PREFIXES) as SearchDocumentPrefix[],
);

/** Prefix → the id registry its ids resolve against (`null` = none). */
export const SEARCH_DOCUMENT_ID_KINDS: Readonly<Record<SearchDocumentPrefix, ReferenceKind | null>> =
  Object.freeze(
    Object.fromEntries(
      SEARCH_DOCUMENT_PREFIXES.map((p) => [p, PREFIXES[p].referenceKind]),
    ) as Record<SearchDocumentPrefix, ReferenceKind | null>,
  );

/** `searchDocumentId('knowledge', 'auth.login')` → `knowledge:auth.login`. */
export function searchDocumentId(prefix: SearchDocumentPrefix, id: string): string {
  return `${prefix}:${id}`;
}

/**
 * `<prefix>:<id>` → `{ prefix, id }`, split on the FIRST `:`. `null` when the
 * key has no `:` or either side is empty. The prefix is NOT validated — pair
 * with {@link isSearchDocumentPrefix}.
 */
export function parseSearchDocumentId(key: string): { readonly prefix: string; readonly id: string } | null {
  const at = key.indexOf(':');
  if (at <= 0 || at === key.length - 1) return null;
  return { prefix: key.slice(0, at), id: key.slice(at + 1) };
}

/** True when `prefix` is one `buildSearchIndex` emits. */
export function isSearchDocumentPrefix(prefix: string): prefix is SearchDocumentPrefix {
  return Object.prototype.hasOwnProperty.call(PREFIXES, prefix);
}

/** The `SearchKind` value the prefix's documents carry, or `undefined`. */
export function searchKindForPrefix(prefix: string): string | undefined {
  return isSearchDocumentPrefix(prefix) ? PREFIXES[prefix].searchKind : undefined;
}

/** The prefix whose documents carry `searchKind` (`construct-facet` → `facet`). */
export function searchDocumentPrefixForKind(searchKind: string): SearchDocumentPrefix | undefined {
  return SEARCH_DOCUMENT_PREFIXES.find((p) => PREFIXES[p].searchKind === searchKind);
}

/** The prefix whose ids live in `kind`'s registry (`path-convention` → `path`). */
export function searchDocumentPrefixForReferenceKind(kind: ReferenceKind): SearchDocumentPrefix | undefined {
  return SEARCH_DOCUMENT_PREFIXES.find((p) => PREFIXES[p].referenceKind === kind);
}

/**
 * The registry entry a search-document id names: `knowledge:gamma.entry` →
 * `{ referenceKind: 'knowledge', id: 'gamma.entry' }`. `undefined` when the id
 * does not parse, its prefix is not one the index emits, or its prefix has no
 * id registry (`doc:`, `preset:`, `facet:`, …) — such a document exists, but
 * no registry can be asked about it.
 */
export function searchDocumentReference(
  docId: string,
): { readonly referenceKind: ReferenceKind; readonly id: string } | undefined {
  const parsed = parseSearchDocumentId(docId);
  if (!parsed || !isSearchDocumentPrefix(parsed.prefix)) return undefined;
  const referenceKind = PREFIXES[parsed.prefix].referenceKind;
  return referenceKind === null ? undefined : { referenceKind, id: parsed.id };
}
