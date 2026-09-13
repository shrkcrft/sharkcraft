import type { IRejectedEntry } from '@shrkcrft/core';
import type { ContributionKind } from './contribution-kind.ts';

/**
 * One rejected contribution entry as THE rejection channel carries it
 * (`collectContributionRejections`, contribution-load-failures.ts): the
 * loader's {@link IRejectedEntry} plus the contribution kind that refused it
 * and the pack that owns the file. Every surface — the list verbs, the
 * self-config doctor, `packs list|get|doctor|contributions`, `packs test
 * --load` — reads this one record (round 12, 12.1).
 */
export interface IContributionEntryRejection extends IRejectedEntry {
  readonly kind: ContributionKind;
  /** Owning pack, when the file is a pack contribution. */
  readonly packageName?: string;
  /**
   * Which evidence reported it: an inspection-time loader diagnostic, a
   * registry loader, or the gate-plane merge seam (`resolveProjectConfig`).
   */
  readonly via: 'loader-diagnostics' | 'registry' | 'config-plane';
}
