import type { KnowledgeSourceFormat } from '@shrkcrft/knowledge';
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
  /**
   * The format the entry is declared in (round 15) — what the remedy for an
   * unverifiable entry names: `references[]` in TypeScript, a `references:`
   * frontmatter list in Markdown.
   */
  readonly sourceFormat: KnowledgeSourceFormat;
  /**
   * The pack that contributed the entry (its package name) — absent for a
   * local one. A pack entry is fixed upstream, or accepted locally.
   */
  readonly pack?: string;
  /** The entry's knowledge `type` (`rule`, `path`, `technical`, …). */
  readonly type: string;
  /** References + anchors whose outcome was a real check (ok / stale / missing). */
  readonly checkable: number;
  /** Of {@link checkable}, how many did not resolve (stale / missing). */
  readonly failing: number;
}
