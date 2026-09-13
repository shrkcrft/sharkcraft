/**
 * A verdict after the coverage guard has run — the only shape a verdict verb
 * may render its final line from. Defined in `@shrkcrft/core` next to
 * `settleVerdict` (round 11 review: one settle derivation for the CLI and the
 * engines below it); re-exported here so CLI imports stay unchanged.
 */
export type { ISettledVerdict } from '@shrkcrft/core';
