/**
 * Which deterministic strategy produced a compression result. Surfaced so
 * callers (and tests) can assert on *how* a payload shrank, not just that it
 * did.
 */
export enum ECompressionStrategy {
  /** No transform applied — output equals input (below threshold, or unknown shape). */
  Passthrough = 'passthrough',
  /** Lossless columnar/table compaction of a homogeneous object array. */
  Table = 'table',
  /** Log line-reduction: kept errors/warnings/summaries, dropped the rest. */
  Log = 'log',
  /** Search-result reduction: kept the highest-signal `file:line` matches. */
  Search = 'search',
  /** Diff reduction: capped files/hunks and trimmed surrounding context. */
  Diff = 'diff',
  /** Generic line dedup for prose / plain text. */
  Lines = 'lines',
  /** Code outline: kept imports / types / signatures, elided function bodies. */
  Code = 'code',
  /** Markdown distilled to headers, section leads, list/table structure; bodies thinned. */
  Markdown = 'markdown',
  /** Minified JSON (whitespace removed, structure preserved). */
  MinifiedJson = 'minified-json',
  /** Lossy statistical row-sample of a huge homogeneous array (SmartCrusher). */
  Sample = 'sample',
  /** Mixed blob segmented by type; each run compressed with its own strategy. */
  Mixed = 'mixed',
}
