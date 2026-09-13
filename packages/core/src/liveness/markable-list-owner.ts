/** The subsystem whose reporter judges a markable list (`IMarkableUnitListSpec.owner`). */
export enum MarkableListOwner {
  /** `@shrkcrft/boundaries` evaluate + the inspector boundary orchestrator. */
  Boundaries = 'boundaries',
  /** The data-defined gate planes (`sharkcraft.config.ts` wiringRules … docReferences). */
  GatePlanes = 'gate-planes',
  /** Contributed assets: registration hints, scaffold patterns, search tuning. */
  Assets = 'assets',
}
