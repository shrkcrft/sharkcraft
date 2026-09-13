import type { RejectionCause } from './rejection-cause.ts';

/**
 * One declared entry a contribution loader refused — the record every loader
 * returns next to its accepted entries (round 12, 12.1), never a silent
 * `continue`. The conservation law every loader keeps: for a file that
 * loaded, `accepted + rejected === declared`.
 *
 * Lives in core so the lower-layer loaders (knowledge, templates, pipelines,
 * presets) emit it within the layer order.
 */
export interface IRejectedEntry {
  /** Absolute path of the declaring file. */
  readonly file: string;
  /** Position in the exported list; `-1` for a single-object export. */
  readonly index: number;
  /** The export the entry came from (`default`, `conventions`, `entries`, …), when known. */
  readonly exportName?: string;
  /** The entry's id, when it carried a string one. */
  readonly entryId?: string;
  /** EVERY failing check, each `<field>: <message>` — never only the first. */
  readonly reasons: readonly string[];
  readonly cause: RejectionCause;
}
