/** What {@link readContributionExport} read from a contribution module. */
export interface IContributionExport {
  /** The declared entries, in export order. */
  readonly items: readonly unknown[];
  /** The export they came from (`default`, `conventions`, …); `null` when the module exports no recognised list. */
  readonly exportName: string | null;
  /** True when a single default-exported object was read as a one-entry list — its index is `-1`. */
  readonly single: boolean;
}
