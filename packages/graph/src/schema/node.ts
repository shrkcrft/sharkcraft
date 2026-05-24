import type { NodeKind } from './node-kind.ts';

/**
 * A node in the code graph.
 *
 * `id` is namespaced by kind: `file:packages/foo/src/bar.ts`,
 * `symbol:packages/foo/src/bar.ts#fooFn`, `package:@shrkcrft/foo`.
 *
 * `data` holds kind-specific structured payload — typed at write via
 * the helper builders in `indexer/` rather than enforced via a
 * discriminated union here (the union would balloon and gain little).
 */
export interface INode {
  id: string;
  kind: NodeKind;
  /** Short, deterministic display label. */
  label: string;
  /** Project-relative path for File / Symbol; undefined otherwise. */
  path?: string;
  /** 1-based line number for Symbol nodes; undefined otherwise. */
  line?: number;
  /** Free-form, sorted, deduped tags. */
  tags?: readonly string[];
  /** Kind-specific structured payload. */
  data?: Readonly<Record<string, unknown>>;
}
