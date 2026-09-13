import type { ContributionKind } from './contribution-kind.ts';

/**
 * One knowledge-family entry (knowledge / rule / path / docs) its loader
 * REFUSED — read off THE rejection channel by `knowledgeRejectedEntries`
 * (round 15 follow-up, F3). The entry never reached the corpus, so nothing it
 * claims was checked: the stale-check prints it as an INVALID-class row, the
 * `quality` knowledge item and `shrk doctor` name it, and every one of them
 * counts it UNEXAMINED — never a clean pass.
 */
export interface IKnowledgeRejectedEntry {
  /** The id the entry declared, when it declared one. */
  readonly entryId?: string;
  /** What a row names it by: the id, else `<file> <where>` (or the file alone). */
  readonly label: string;
  /** The declaring file — project-relative (POSIX), absolute outside the project. */
  readonly source: string;
  /** Where in the file (`default[1]`, a named export), when the loader recorded a position. */
  readonly at?: string;
  /** The contribution kind whose loader refused it. */
  readonly kind: ContributionKind;
  /** The pack that contributed the file — absent for a local one. */
  readonly pack?: string;
  /** Why the loader refused it, as the loader said. */
  readonly reasons: readonly string[];
  /** THE row wording: `rejected at load — not checked: <reasons>`. */
  readonly message: string;
}
