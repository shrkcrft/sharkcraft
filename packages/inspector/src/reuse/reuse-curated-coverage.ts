import type { ReuseImportStyle } from '@shrkcrft/core';
import type { ReuseCuratedStatus } from './reuse-curated-status.ts';

/** One curated `reusePrimitives[]` entry measured against the code graph. */
export interface IReuseCuratedCoverage {
  readonly symbol: string;
  readonly status: ReuseCuratedStatus;
  /**
   * False when the status could not be measured: the only exported
   * declarations live in a package with no resolved entry, so whether they are
   * public is unknown (the status then reads as the best available, NOT as a
   * finding).
   */
  readonly statusMeasured: boolean;
  /** Why the status was not measured. */
  readonly statusNote?: string;
  /** Packages whose public surface exposes the symbol. */
  readonly publicIn: readonly string[];
  /** Every indexed declaration of the name. */
  readonly declaredIn: readonly string[];
  readonly declKind?: string;
  /** Real consumer files of the (primary) declaration, when the graph was asked. */
  readonly consumers?: number;
  readonly importPath?: string;
  /**
   * `true` / `false` when the configured `importPath` was checked: does the
   * module it names expose the symbol (would the copy-paste import `shrk reuse`
   * prints compile)? Absent when it could not be checked — see `importPathNote`.
   */
  readonly importPathAgrees?: boolean;
  readonly importPathNote?: string;
  /** How the printed import binds the symbol — `default` for a default export. */
  readonly importStyle?: ReuseImportStyle;
  /** The exact import line `shrk reuse` prints for this entry (same resolver). */
  readonly importLine?: string;
}
