/**
 * The CLI's one exit guard — `settleVerdict(proposed, coverage)`: a verb
 * PROPOSES an exit from what it found, and the coverage of what it examined may
 * veto a clean one (proposed `0` with any shortfall → `2`; `1`, `2` and `3` are
 * never changed).
 *
 * Round 11 review: the fold moved to `@shrkcrft/core` so the boundary
 * orchestrator (read by finish, quality and the MCP tools, which cannot import
 * the CLI) settles with the SAME function instead of a second copy. This path
 * stays as a re-export so every CLI caller — `buildGateEnvelope`, `quality`,
 * `gate` — keeps its import unchanged.
 */
export { settleVerdict } from '@shrkcrft/core';
