/** An entry whose `verifiedOn` is older than `--stale-after`. */
export interface IKnowledgeAgedEntry {
  readonly entryId: string;
  readonly verifiedOn: string;
  /** Whole days from `verifiedOn` to the sweep's `asOf`. */
  readonly ageDays: number;
  /** Where the entry is declared, relative to the project root. */
  readonly source: string;
}
