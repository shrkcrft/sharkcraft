/**
 * What resolving one search-tuning boost key (`boostIds` /
 * `taskHints[].boostIds`) against the live registries found.
 *
 * A boost key is a SEARCH-DOCUMENT id (`<kind>:<id>`, see
 * `search-document-id.ts`): the matcher compares it to `doc.id` whole.
 */
export enum SearchTuningKeyStatus {
  /** `<kind>:<id>` whose id is registered under that kind — the boost can fire. */
  Resolved = 'resolved',
  /** `<kind>:<id>` whose id is NOT registered under that kind — dead. */
  Missing = 'missing',
  /** A bare id (no `<kind>:` prefix) — no search document is keyed like that, so it never fires. */
  Unprefixed = 'unprefixed',
  /** `<prefix>:<id>` whose prefix is not a search-document kind — dead. */
  UnknownKind = 'unknown-kind',
  /**
   * NOT checked: the kind has no id registry (preset, pack, bundle, session,
   * facet, doc) or its registry is empty in this workspace. Never reported as
   * missing — a check that cannot look must say so instead of guessing.
   */
  Unverified = 'unverified',
}
