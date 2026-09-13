/**
 * Where a curated `reusePrimitives[]` entry stands against the code.
 *
 * - `public`              — on a workspace package's public export surface.
 * - `exported-not-public` — exported from its file, but no package entry
 *   reaches it (a consumer cannot import it from a package root).
 * - `not-exported`        — declared, never exported.
 * - `not-found`           — no declaration of that name anywhere in the index:
 *   a dead entry (a rename, a typo) that every `shrk reuse` answer would
 *   still recommend. Fails `shrk reuse coverage`.
 * - `ambiguous`           — several exported declarations and none public,
 *   so which one the entry means is unknowable.
 */
export enum ReuseCuratedStatus {
  Public = 'public',
  ExportedNotPublic = 'exported-not-public',
  NotExported = 'not-exported',
  NotFound = 'not-found',
  Ambiguous = 'ambiguous',
}
