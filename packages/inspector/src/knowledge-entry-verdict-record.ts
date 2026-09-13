import type { KnowledgeEntryVerdict } from './knowledge-entry-verdict.ts';
import type { KnowledgeUnverifiableReason } from './knowledge-unverifiable-reason.ts';

/** One entry in scope, classified — the unit the stale-check's coverage counts. */
export interface IKnowledgeEntryVerdictRecord {
  readonly entryId: string;
  readonly verdict: KnowledgeEntryVerdict;
  /** Set when {@link verdict} is `unverifiable`. */
  readonly reason?: KnowledgeUnverifiableReason;
  /**
   * Where the entry is declared, relative to the project root
   * (`sharkcraft/rules.ts`) — so the fix for an unverifiable entry names the
   * file to edit. `(unknown source)` when the loader recorded none.
   */
  readonly source: string;
  /** The entry's knowledge `type` (`rule`, `path`, `technical`, …). */
  readonly type: string;
  /** References + anchors whose outcome was a real check (ok / stale / missing). */
  readonly checkable: number;
  /** Of {@link checkable}, how many did not resolve (stale / missing). */
  readonly failing: number;
}
