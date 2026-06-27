/**
 * Options for the architecture-guard gate.
 */
export interface IArchGateOptions {
  /**
   * When true (the DEFAULT) and a frozen baseline exists, the gate fails only on
   * NEW architecture errors (violations absent from the baseline) and surfaces
   * the total pre-existing debt as informational — so the gate isn't a perpetual
   * red on baseline debt the current diff never introduced.
   *
   * Set to false to fail on ANY error regardless of the baseline (the legacy
   * behavior; useful for a clean-tree CI demand).
   */
  baselineRelative?: boolean;
}
