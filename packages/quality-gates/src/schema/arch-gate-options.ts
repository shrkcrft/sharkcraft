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
  /**
   * Change-scoped attribution set: the project-relative ('/'-normalised) files
   * the working diff actually touched (diff vs HEAD). When provided (even an
   * empty array), a NEW-since-baseline violation is BLOCKING only if its origin
   * file is in this set; a NEW violation in an untouched file is demoted to
   * INFORMATIONAL "baseline drift" and never flips the exit code. This is the
   * fix for §3.1: "NEW" must mean *introduced by this change*, not drift against
   * a frozen (possibly months-old) baseline.
   *
   * `undefined` disables change-scoped attribution (legacy behaviour: any
   * NEW-since-baseline violation blocks). An empty array means "clean tree — no
   * change-attributable violations" (a pass for THIS change), keeping the
   * informational drift line visible.
   */
  changedFiles?: readonly string[];
}
