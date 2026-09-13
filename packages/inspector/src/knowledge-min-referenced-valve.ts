/**
 * Which `minReferenced` valve a surface can name. `shrk knowledge stale-check`
 * takes the flag; `shrk quality` refuses `--min-referenced` (exit 3) and reads
 * the config block only — so its remedy names `knowledgeCheck.minReferenced`.
 */
export enum KnowledgeMinReferencedValve {
  /** `--min-referenced <ratio>` on the verb (the config key works there too). */
  Flag = 'flag',
  /** `knowledgeCheck.minReferenced` in `sharkcraft.config.ts` — the only valve `quality` reads. */
  Config = 'config',
}
