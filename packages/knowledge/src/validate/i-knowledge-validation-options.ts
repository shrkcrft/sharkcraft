import type { IKnowledgeEntry } from '../model/knowledge-entry.ts';

/** What `validateKnowledgeEntries` needs to know beyond the entries themselves. */
export interface IKnowledgeValidationOptions {
  /**
   * Whether a pack contributed this entry — the provenance `root: pack` needs
   * (a local entry has no pack directory to resolve against). Default: no
   * entry is (a caller validating local entries). The inspection answers from
   * its entry sources; `packs test --load` answers `true` for every entry of
   * the pack file it validates.
   */
  readonly isPackContributed?: (entry: IKnowledgeEntry) => boolean;
}
