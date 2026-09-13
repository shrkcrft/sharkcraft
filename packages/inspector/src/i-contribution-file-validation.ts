import type { IRejectedEntry } from '@shrkcrft/core';
import type { IKnowledgeValidationIssue } from '@shrkcrft/knowledge';
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
  /**
   * Issues THE knowledge validator (`validateKnowledgeEntries`) reports on
   * entries the loader ACCEPTED — the entry is kept, and the consumer's doctor
   * reports the same issue (a non-list `references`, a malformed reference
   * item). Knowledge-bearing slots only; absent when there are none (round 15).
   */
  readonly entryIssues?: readonly IKnowledgeValidationIssue[];
  /** True when no build-time validator exists for this slot (a reserved slot) — nothing was checked. */
  readonly unvalidated?: boolean;
}
