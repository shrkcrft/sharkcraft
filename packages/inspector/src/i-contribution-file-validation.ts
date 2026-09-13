import type { IRejectedEntry } from '@shrkcrft/core';
import type { ContributionKind } from './contribution-kind.ts';

/**
 * One contribution file validated at BUILD time through the runtime loader (or
 * THE acceptance predicate) the engine applies to it at load — what `shrk packs
 * test --load` reports per declared file (round 12, 12.1f). An unannotated
 * literal is refused exactly as it will be at runtime, with no type-check.
 */
export interface IContributionFileValidation {
  /** The manifest slot that declares the file (`conventionFiles`, …). */
  readonly slot: string;
  readonly kind?: ContributionKind;
  /** Absolute path. */
  readonly file: string;
  /** False when the file does not exist or failed to import. */
  readonly loaded: boolean;
  readonly loadError?: string;
  readonly accepted: number;
  readonly acceptedIds: readonly string[];
  readonly rejected: readonly IRejectedEntry[];
  /** True when no build-time validator exists for this slot (a reserved slot) — nothing was checked. */
  readonly unvalidated?: boolean;
}
