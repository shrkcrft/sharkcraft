/** Why an entry landed in the `unverifiable` bucket. */
export enum KnowledgeUnverifiableReason {
  /** It declares no `references[]` and no `anchors[]`. */
  NoReferences = 'no-references',
  /**
   * It declares some, but none can be checked: every one is a `url`, an
   * unpinned symbol, a reference missing its required field, or an id whose
   * registry is empty / was not loaded.
   */
  OnlyUnverifiableReferences = 'only-unverifiable-references',
}
