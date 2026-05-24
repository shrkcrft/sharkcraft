import type { EdgeKind } from './edge-kind.ts';

/**
 * An edge in the code graph.
 *
 * `id` is deterministic: sha1(from || '|' || to || '|' || kind). Two
 * extractors emitting the same logical edge collapse to one row in the
 * store.
 *
 * `source` records which extractor created the edge, with version. Used
 * to invalidate edges when an extractor's behaviour changes.
 */
export interface IEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  /** e.g. 'extract-ts-file@v1'. */
  source: string;
  /** Kind-specific structured payload. */
  data?: Readonly<Record<string, unknown>>;
}
