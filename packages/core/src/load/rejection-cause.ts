/**
 * Why a contribution loader refused ONE declared entry (round 12, 12.1).
 *
 * A refused entry used to be a silent `continue`: the author's file compiled,
 * the `list` verb printed the survivors and every doctor reported zero errors.
 * Every loader now records the refusal as an {@link IRejectedEntry} instead,
 * and one channel (`collectContributionRejections`, @shrkcrft/inspector)
 * carries it to every surface.
 */
export enum RejectionCause {
  /** The entry fails its loader's acceptance predicate: a required field is missing or malformed. */
  Invalid = 'invalid',
  /** An earlier entry of the same kind already claimed the id, so this one never takes effect. */
  DuplicateId = 'duplicate-id',
}
