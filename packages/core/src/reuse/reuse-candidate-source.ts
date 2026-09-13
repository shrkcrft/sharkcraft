/**
 * Where a reuse candidate came from.
 *
 * - `curated`        — a `reusePrimitives[]` entry a human declared.
 * - `export-surface` — an UNCURATED construct found on a workspace package's
 *   public export surface. Always labelled as such: nobody vouched for it.
 */
export enum ReuseCandidateSource {
  Curated = 'curated',
  ExportSurface = 'export-surface',
}
