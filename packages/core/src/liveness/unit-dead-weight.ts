/**
 * How a dead unit of a list weighs on the verdict (`IMarkableUnitListSpec.weight`).
 */
export enum UnitDeadWeight {
  /** Listed and the ✓ is withheld; the exit is unchanged unless `--fail-on-dead-units`. */
  Advisory = 'advisory',
  /** A coverage shortfall (settle record A): the verdict settles NOT VERIFIED (2). */
  Coverage = 'coverage',
}
