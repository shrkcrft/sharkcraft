import type { RejectionCause } from '@shrkcrft/core';
import type { ContributionKind } from './contribution-kind.ts';
import type { UnresolvableReason } from './unresolvable-reason.ts';

/**
 * One contributed FILE in `shrk packs contributions`' `By file:` report (round
 * 12, ONE-CHANGE): did what I wrote take effect? Entries accepted, entries
 * rejected with every reason, and references that could not be checked
 * because their kind's registry is empty or undeclarable. The conservation
 * law holds per file: `accepted + rejected.length === declared`.
 */
export interface IContributionFileReport {
  /** Project-relative (absolute when outside the project). */
  readonly file: string;
  readonly kind: ContributionKind;
  readonly packageName?: string;
  readonly source: 'local' | 'pack';
  /** `failed` — the file failed to import; `missing` — a pack declares it and it is not on disk. */
  readonly status: 'loaded' | 'failed' | 'missing';
  readonly declared: number;
  readonly accepted: number;
  readonly acceptedIds: readonly string[];
  readonly rejected: readonly {
    readonly index: number;
    readonly exportName?: string;
    readonly entryId?: string;
    readonly reasons: readonly string[];
    readonly cause: RejectionCause;
  }[];
  /** The import error's first line, for a `failed` file. */
  readonly loadError?: string;
  /** Declared references in this file that could not be checked, grouped by (source, field, kind, reason). */
  readonly unresolvableReferences: readonly {
    readonly sourceId: string;
    readonly field: string;
    readonly kind: string;
    readonly ids: readonly string[];
    readonly reason: UnresolvableReason;
  }[];
}
